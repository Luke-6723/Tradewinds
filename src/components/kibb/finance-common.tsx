"use client";

// Pieces shared by the loans, banks, ventures and ship-shares pages (guide 3.13).

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KV, NativeSelect } from "@/components/kibb/bits";
import { Field, GoodSelect, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { fetchAll } from "@/components/kibb/trade-common";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import { creditBlemishes, dailyBasis, YEAR_DAYS } from "@/lib/kibb/fleet/finance";
import type { FinanceReport } from "@/lib/kibb/fleet/manager";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult } from "@/lib/kibb/types";

// ── Rules (guide 3.13) ────────────────────────────────────────────────────────

/**
 * Loans by quote (guide 3.13.1-3.13.2): at least 100 Cr, 1..=360 game days, a fixed annual rate (bps per 360 game days)
 * within 10%..=300% of the Goldsmiths' rate for the term. The Goldsmiths: at most 40% of a ship's rebuild value and 7,500 Cr,
 * 45% a year up to 30 game days sliding to 30% at 360, a quote standing 6 game hours. Requests stay open 1..=72 game hours
 * (default 24); amortised installments fall every 10 game days; a foreclosed ship is credited at 80% of its rebuild value by a
 * player lender or on a Goldsmiths' ship mortgage, but at only 35% (the break-up price, no surplus) on a Goldsmiths' instant
 * loan. After any walk-away the Goldsmiths lend nothing for a real day (403 goldsmiths_walk_away_ban).
 */
export const LOAN = {
  minPrincipalPence: 10_000,
  termMaxDays: 360,
  goldsmithsMaxPence: 750_000,
  goldsmithsLtvBps: 4_000,
  quoteGameHours: 6,
  requestHoursMax: 72,
  requestHoursDefault: 24,
  installmentEveryDays: 10,
  foreclosureCreditPct: 80,
  goldsmithsForeclosureCreditPct: 35,
} as const;

/**
 * Banks: 10,000 Cr fee, 50,000 Cr of own funds after it, 20% reserve, rates 0..=50 bps a day, notice 1..=720 game hours;
 * exchange fees 0..=1,200 bps a region; client terms a rate bonus of 0..=50 bps a day and an exchange discount of 0..=1,200.
 */
export const BANK = {
  charterFeePence: 1_000_000,
  ownFundsPence: 5_000_000,
  reserveBps: 2_000,
  rateMaxBps: 50,
  noticeHoursMax: 720,
  minDepositPence: 1_000,
  insuredCoverPence: 250_000,
  insuredAfterDays: 14,
  exchangeFeeMaxBps: 1_200,
  clientBonusMaxBps: 50,
} as const;

/**
 * Lending lines (guide 3.13.8): a rate of 10%..=300% of the Goldsmiths' rate for each request's term (1000..=30000 bps of it),
 * loan-to-value 1..=10000 bps, terms up to 360 game days, principal at least 100 Cr, "no default within" 1..=3600 game days.
 * A line's quote stands 6 game hours at most.
 */
export const LINE = {
  rateMinBps: 1_000,
  rateMaxBps: 30_000,
  ltvMaxBps: 10_000,
  termMaxDays: 360,
  minPrincipalPence: 10_000,
  noDefaultMaxDays: 3_600,
  quoteGameHours: 6,
} as const;

/** "60% of the Goldsmiths'": a lending line's rate, as a share of the Goldsmiths' rate for the term. */
export const lineRateText = (bps: number) => `${(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}% of the Goldsmiths'`;

/** A bank's best lending-line rate per pledge (`lending_line_best_rates`), cheapest first, in words; "" for none. */
export const bestRatesText = (rates: Record<string, number> | null | undefined) =>
  Object.entries(rates ?? {})
    .sort((a, b) => a[1] - b[1])
    .map(([k, bps]) => `${COLLATERAL_LABEL[k as S.CollateralKind] ?? k.replace(/_/g, " ")} ${(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`)
    .join(", ");

/** Ventures: investors take 25%..=90% of the profit after 2% stamp duty; raise 1..=168 game hours (default 24); stakes ≥ 10 Cr. */
export const VENTURE = { shareMinBps: 2_500, shareMaxBps: 9_000, stampDutyBps: 200, raiseHoursMax: 168, raiseHoursDefault: 24, minStakePence: 1_000 } as const;

/** What a default does, in the guide's terms (3.13.1): a player lender's loan, or a Goldsmiths' ship mortgage. */
export const DEFAULT_WARNING =
  "Not repaid by maturity (or an amortised installment unpaid a game day after it falls due), a loan defaults: a liened ship goes to the lender where it lies, credited at 80% of its rebuild value (the lender pays you any surplus over what you owe; on a player lender's loan or a Goldsmiths' ship mortgage, not on a Goldsmiths' instant loan), and is arrested until then (it can't depart or join a convoy, and your cargo left aboard is sold at half base price toward the debt); pledged goods move to the lender's warehouse; with recourse the rest is taken from your vaults daily. The default stays on your public credit record.";

/** What a default (or a walk-away) does on a Goldsmiths' instant loan (guide 3.13.1): the break-up credit, no surplus, the rest owed. */
export const GOLDSMITHS_DEFAULT_WARNING =
  "On a Goldsmiths' instant loan a default (at maturity, a missed installment, walking away or bankruptcy) is harsher: they take the pledged ship credited only at what a yard would pay to break it up, 35% of its rebuild value, pay you no surplus, and whatever you owed above that is NOT written off: it stays owed with recourse and the bailiff takes it from your vaults (any region) until paid. A ship sunk or lost first credits nothing. The ship is arrested until they have it, and the default stays on your public credit record.";

/**
 * A Goldsmiths' instant loan (taken on their quote: no player's request behind it, not a ship mortgage), whose default credits
 * the ship at its break-up value only (GOLDSMITHS_DEFAULT_WARNING).
 */
export const isGoldsmithsInstant = (l: Pick<S.Loan, "is_mortgage" | "request_id" | "quote_id">) => !l.is_mortgage && !l.request_id && !!l.quote_id;

/** After any walk-away (any lender), the Goldsmiths lend nothing for a real day (guide 3.13.1: 403 goldsmiths_walk_away_ban). */
export const WALK_AWAY_BAN_WARNING =
  "After any walk-away, the Goldsmiths give no instant quote or loan to you, or to your own and linked companies, for one real day (the autopilot borrows nothing until then).";

/** Number input value → number; empty → NaN. */
export const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

/** Crowns typed into a field → pence (NaN stays NaN). */
export const crToPence = (v: string) => Math.round(num(v) * 100);

/** The first message whose condition fails, else null. */
export function firstProblem(checks: Array<[boolean, string]>): string | null {
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

/** Simple interest on `principal` at an annual `rateBps` (per 360 game days) over `days` (the most a loan run to term costs). */
export const interestFor = (principalPence: number, annualBps: number, days: number) => Math.ceil((principalPence * annualBps * days) / (10_000 * YEAR_DAYS));

/** An annual loan rate: "36%/yr", with the bps and its 30-day cost as a tooltip. */
export function AnnualRateText({ bps }: { bps: number | null | undefined }) {
  if (bps === null || bps === undefined) return <>—</>;
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={`${bps} bps per 360 game days, simple; ${((bps * 30) / YEAR_DAYS / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}% over 30 game days`}
    >
      {(bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%/yr
    </span>
  );
}

/** A loan's own rate: annual for every loan by quote, per game day for one made before them (`rate_basis: "daily"`). */
export function LoanRateText({ loan }: { loan: Pick<S.Loan, "rate_basis" | "daily_rate_bps" | "annual_rate_bps"> }) {
  return dailyBasis(loan) ? <RateText bps={loan.daily_rate_bps} /> : <AnnualRateText bps={loan.annual_rate_bps} />;
}

/** "50 bps/day" with the 30-day equivalent as a tooltip (bank rates, and loans made before loans by quote). */
export function RateText({ bps }: { bps: number | null | undefined }) {
  if (bps === null || bps === undefined) return <>—</>;
  return (
    <span className="whitespace-nowrap tabular-nums" title={`${((bps * 30) / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}% over 30 game days, simple`}>
      {bps} bps/day
    </span>
  );
}

export const regionName = (r: string | null | undefined) => (r ? r.replace(/_/g, " ") : "—");

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

/** A box of warnings in the warning colour. */
export function WarnBox({ children, tone = "warning" }: { children: ReactNode; tone?: "warning" | "error" | "info" }) {
  const cls =
    tone === "error"
      ? "bg-destructive/10 text-destructive"
      : tone === "info"
        ? "bg-info/10 text-info-foreground"
        : "bg-warning/10 text-warning-foreground";
  return <div className={`space-y-1 rounded-md px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

// ── Company names ─────────────────────────────────────────────────────────────
// Loans carry only company ids. Names are learnt from what the pages read (board entries, banks, ventures, our own
// companies) into one store for the session, so a counterparty seen anywhere is named everywhere.

const names = new Map<string, string>();
let namesVersion = 0;
const listeners = new Set<() => void>();

function noteCompanies(pairs: Array<[string | null | undefined, string | null | undefined]>) {
  let changed = false;
  for (const [id, name] of pairs) {
    if (!id || !name || names.get(id) === name) continue;
    names.set(id, name);
    changed = true;
  }
  if (changed) {
    namesVersion++;
    for (const l of listeners) l();
  }
}

/** Notes id → name pairs once they change (in an effect, never during render). */
export function useLearnCompanies(pairs: Array<[string | null | undefined, string | null | undefined]> | undefined) {
  const sig = (pairs ?? []).map(([a, b]) => `${a ?? ""}:${b ?? ""}`).join("|");
  useEffect(() => {
    if (pairs?.length) noteCompanies(pairs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

export interface CompanyNames {
  /** The name if known, else null. */
  nameOf: (id: string | null | undefined) => string | null;
  /** The name, or the id's first 8 characters. */
  label: (id: string | null | undefined) => string;
  /** The id of a company by exact name (case-insensitive), if seen. */
  idByName: (name: string) => string | undefined;
  all: () => Array<[string, string]>;
}

export function useCompanyNames(): CompanyNames {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => namesVersion,
    () => 0,
  );
  return {
    nameOf: (id) => (id ? (names.get(id) ?? null) : null),
    label: (id) => (id ? (names.get(id) ?? shortId(id)) : "—"),
    idByName: (name) => {
      const n = name.trim().toLowerCase();
      for (const [id, nm] of names) if (nm.toLowerCase() === n) return id;
      return undefined;
    },
    all: () => [...names.entries()].sort((a, b) => a[1].localeCompare(b[1])),
  };
}

/**
 * Reads the public sources of company names every 5 minutes (every bank, the open loan requests in every region, our own
 * requests with the lenders who quoted on them, our own companies) so loans, deposits and credit lookups can show names.
 */
export function useCompanyDirectory() {
  const { data: ours } = usePoll(() => dash.get<{ companies: Array<{ id: string; name: string }> }>("/api/kibb/companies"), 300_000);
  const { data: banks } = usePoll(() => kibbGet<S.BankResult[]>("/v1/bank/list"), 300_000);
  const { data: requests } = usePoll(
    () =>
      Promise.all([
        kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { limit: 200 }).catch(() => null),
        kibbGet<S.LoanRequestView[]>("/v1/loan/requests", { mine: true, limit: 50 }).catch(() => null),
      ]),
    300_000,
  );
  useLearnCompanies([
    ...(ours?.companies ?? []).map((c) => [c.id, c.name] as [string, string]),
    ...(banks ?? []).map((b) => [b.company_id, b.name] as [string, string]),
    ...(requests ?? []).flatMap((list) =>
      (list ?? []).flatMap((r) => [
        [r.borrower_company_id, r.borrower_name] as [string, string],
        ...(r.quotes ?? []).map((q) => [q.lender_company_id, q.lender_name] as [string, string]),
      ]),
    ),
  ]);
}

/** A company's name with a badge when it is ours or another company of our player. */
export function CompanyLabel({ id, companyId, ourIds }: { id: string | null | undefined; companyId?: string; ourIds?: Set<string> }) {
  const { label } = useCompanyNames();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={label(id) === shortId(id) ? "font-mono text-xs" : undefined}>{label(id)}</span>
      {id && id === companyId ? (
        <Badge variant="info" size="sm">you</Badge>
      ) : id && ourIds?.has(id) ? (
        <Badge variant="secondary" size="sm">your company</Badge>
      ) : null}
    </span>
  );
}

// ── Our data ──────────────────────────────────────────────────────────────────

/** Vault cash per region (pence), refreshed every 30 s. */
export function useVaults() {
  const { data, reload } = usePoll(() => kibbGet<S.TreasuryVaultsResult>("/v1/treasury/vaults"), 30_000);
  const cash = (region: string | null | undefined): number | undefined =>
    data && region ? (data.vaults.find((v) => v.banking_region === region && v.account_type === "vault")?.balance_pence ?? 0) : undefined;
  const total = data ? data.vaults.filter((v) => v.account_type === "vault").reduce((n, v) => n + v.balance_pence, 0) : undefined;
  return { vaults: data?.vaults, cash, total, reload };
}

/** "1,234 Cr in channel" for a form's cash line. */
export function CashLine({ region, cash, need }: { region: string | null | undefined; cash: number | undefined; need?: number }) {
  if (!region) return null;
  const short = cash !== undefined && need !== undefined && Number.isFinite(need) && need > cash;
  return (
    <p className={`text-xs ${short ? "text-destructive" : "text-muted-foreground"}`}>
      {cash === undefined ? "Reading your vaults…" : `${fmtCr(cash)} in your ${regionName(region)} vault`}
      {short ? `: short of the ${fmtCr(need)} needed` : ""}
    </p>
  );
}

export function useShips() {
  return usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 30_000);
}

/**
 * One of our ships' rebuild value (guide 3.4: the class's cheapest current Crown list price at an open yard, at full labour and
 * markup whatever the discount yards charge, plus her guns and fitted components), as
 * the Goldsmiths appraise her: a 100 Cr, 30-day instant quote carries it (stored for 6 game hours, never taken). It fails
 * (409) for a ship liened, listed or carrying a venture, or one that can't carry even that: `rebuild` is then undefined.
 */
export function useAppraisal(shipId: string | null | undefined) {
  const { data, error } = usePoll(
    shipId
      ? () =>
          kibbGet<S.GoldsmithsQuote>("/v1/loan/quote", { principal_pence: LOAN.minPrincipalPence, term_game_days: 30, repayment: "balloon", ship_id: shipId }).then((q) => ({
            shipId,
            rebuild: q.rebuild_value_pence,
          }))
      : null,
    0,
    [shipId],
  );
  return { rebuild: data && data.shipId === shipId ? data.rebuild : undefined, error: shipId ? error : null };
}

export interface FleetFinance {
  /** The autopilot is enabled for this company. */
  running: boolean;
  finance: FinanceReport | null;
  /** Ships it sails. */
  ships: Set<string>;
  /** What the autopilot took a loan for (it repays its own), or null when it isn't one of its loans. */
  purposeOf: (loanId: string) => string | null;
  /** One of the autopilot's idle-cash quotes on a player's request. */
  isAutopilotQuote: (quoteId: string) => boolean;
  /** One of the autopilot's requests for quotes (posted to refinance a Goldsmiths' loan). */
  isAutopilotRequest: (requestId: string) => boolean;
}

/** The fleet autopilot's view of our loans (guide 3.13 via its finance report), when it has one. */
export function useFleetFinance(): FleetFinance {
  const { data } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 30_000);
  const finance = data?.state?.finance ?? null;
  const running = !!data?.enabled;
  return {
    running,
    finance,
    ships: new Set(running ? (data?.state?.agents ?? []).map((a) => a.shipId) : []),
    purposeOf: (id) => finance?.borrowed.find((r) => r.id === id)?.purpose ?? null,
    // Absent from a manager running code from before loans by quote.
    isAutopilotQuote: (id) => !!finance?.quotes?.some((q) => q.id === id),
    isAutopilotRequest: (id) => !!finance?.requests?.some((r) => r.id === id),
  };
}

/** Loans of ours by status, every page (newest first). */
export async function loansOf(role: S.LoanRole, statuses: S.LoanStatus[]): Promise<S.Loan[]> {
  const lists = await Promise.all(statuses.map((status) => fetchAll<S.Loan>("/v1/loan/list", { role, status }, 50, 10)));
  return lists.flat();
}

/**
 * Our ships under a lender's lien (an active or defaulted loan we owe that pledges them): they can't be pledged again,
 * listed, sold or carry a venture; a defaulted one is arrested.
 */
export function usePledgedShips() {
  const { data, error, reload } = usePoll(() => loansOf("borrower", ["active", "defaulted"]), 30_000);
  const byShip = new Map<string, S.Loan>();
  for (const l of data ?? []) {
    if (l.collateral_kind === "ship_lien" && l.collateral_ship_id && l.collateral_status !== "released" && l.collateral_status !== "lost") {
      byShip.set(l.collateral_ship_id, l);
    }
  }
  return { known: data !== undefined, error, byShip, reload };
}

// ── Display ───────────────────────────────────────────────────────────────────

const LOAN_STATUS: Record<S.LoanStatus, "info" | "success" | "warning" | "error" | "outline" | "secondary"> = {
  offered: "info",
  active: "secondary",
  repaid: "success",
  defaulted: "error",
  recovered: "warning",
  written_off: "error",
  withdrawn: "outline",
  declined: "outline",
  lapsed: "outline",
};

export function LoanStatusBadge({ status }: { status: S.LoanStatus }) {
  return (
    <Badge variant={LOAN_STATUS[status] ?? "outline"} size="sm">
      {status.replace("_", " ")}
    </Badge>
  );
}

/** A Goldsmiths' ship mortgage (guide 3.4: taken with a build, amortised over 180 game days, one at a time). */
export function MortgageBadge({ loan }: { loan: Pick<S.Loan, "is_mortgage"> }) {
  if (!loan.is_mortgage) return null;
  return (
    <Badge variant="info" size="sm" title="A Goldsmiths' ship mortgage taken with a build: a lien on the new ship with recourse, amortised over 180 game days; one at a time">
      mortgage
    </Badge>
  );
}

/** A loan a bank's lending line quoted on its own (guide 3.13.8: `lending_line_id`). */
export function LendingLineBadge({ loan }: { loan: Pick<S.Loan, "lending_line_id"> }) {
  if (!loan.lending_line_id) return null;
  return (
    <Badge variant="outline" size="sm" title={`Quoted on its own by the bank's lending line ${shortId(loan.lending_line_id)}`}>
      lending line
    </Badge>
  );
}

export const COLLATERAL_LABEL: Record<S.CollateralKind, string> = {
  ship_lien: "Ship lien",
  warehouse_goods: "Warehouse goods",
  contract_receivable: "Contract receivable",
  deposit: "Bank deposit",
  unsecured: "Unsecured",
};

/** What secures a loan, in words. */
export function CollateralText({ loan, shipName }: { loan: S.Loan; shipName?: (id: string) => string | undefined }) {
  const { portName, goodName } = useCatalog();
  const what =
    loan.collateral_kind === "ship_lien"
      ? `Lien on ${(loan.collateral_ship_id && shipName?.(loan.collateral_ship_id)) ?? `ship ${shortId(loan.collateral_ship_id)}`}`
      : loan.collateral_kind === "warehouse_goods"
        ? `${fmtTons(loan.collateral_tons ?? 0)} ${goodName(loan.collateral_commodity_id)} at ${portName(loan.collateral_port_id)}`
        : loan.collateral_kind === "contract_receivable"
          ? `Receivable on contract ${shortId(loan.collateral_contract_id)}`
          : loan.collateral_kind === "deposit"
            ? `Bank deposit ${shortId(loan.collateral_deposit_id)} (set off against what is owed on a default)`
            : "Unsecured";
  return (
    <span className="text-xs">
      {what}
      {loan.collateral_status !== "none" && loan.collateral_kind !== "unsecured" && (
        <span className="text-muted-foreground"> · {loan.collateral_status.replace("_", " ")}</span>
      )}
      {!loan.recourse && <span className="text-muted-foreground"> · non-recourse</span>}
    </span>
  );
}

/**
 * A company's public credit record (guide 3.13.7): "clean" as the autopilot's idle-cash lending reads it (no default ever,
 * walk-away, write-off, open futures claim, bankruptcy or smuggling conviction).
 */
export function CreditRecordView({ report }: { report: S.CreditReport }) {
  const blemishes = creditBlemishes(report);
  const walked = report.loans_walked_away ?? 0;
  const convictions = report.smuggling_convictions ?? 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{report.company_name}</span>
        <Badge variant={blemishes.length ? "error" : "success"} size="sm" title={blemishes.join(", ") || undefined}>
          {blemishes.length ? "blemished" : "clean"}
        </Badge>
        {report.bankrupt_at && <Badge variant="error" size="sm">bankrupt {fmtDateTime(report.bankrupt_at)}</Badge>}
        {walked > 0 && <Badge variant="error" size="sm">walked away from {walked}</Badge>}
        {convictions > 0 && (
          <Badge variant="error" size="sm">
            {convictions} smuggling conviction{convictions === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
      <KV
        rows={[
          ["Owes now (active loans)", `${fmtCr(report.active_owed_pence)} on ${report.active_loans}`],
          ["Ship mortgages open", report.open_mortgages ? `${report.open_mortgages} (one at a time)` : "none"],
          ["Defaulted, still owed", report.defaulted_open_loans ? `${fmtCr(report.defaulted_owed_pence)} on ${report.defaulted_open_loans}` : "none"],
          ["Loans repaid", report.loans_repaid],
          ["Loans defaulted (ever)", report.loans_defaulted],
          ["Walked away from", walked ? `${walked} (${fmtCr(report.loan_walked_away_pence ?? 0)} their lenders lost)` : "none"],
          ["Written off", report.loans_written_off ? `${report.loans_written_off} (${fmtCr(report.loan_written_off_pence)})` : "none"],
          ["Last default", report.last_default_at ? fmtDateTime(report.last_default_at) : "never"],
          ["Smuggling convictions", convictions ? `${convictions}${report.last_conviction_at ? `, the last ${fmtDateTime(report.last_conviction_at)}` : ""}` : "none"],
          ["Futures claims open", fmtCr(report.futures_claims_open_pence)],
          ["Futures claims (ever / written off)", `${report.futures_claims_total} / ${report.futures_claims_written_off}`],
          ["Lent out now", fmtCr(report.lent_outstanding_pence)],
        ]}
      />
    </div>
  );
}

// ── Pledges ───────────────────────────────────────────────────────────────────

export interface Pledge {
  shipId: string;
  portId: string;
  goodId: string;
  tons: string;
  contractId: string;
  depositId: string;
}

export const EMPTY_PLEDGE: Pledge = { shipId: "", portId: "", goodId: "", tons: "", contractId: "", depositId: "" };

/** The request fields a collateral kind needs. */
export function pledgeBody(kind: S.CollateralKind, p: Pledge) {
  if (kind === "ship_lien") return { ship_id: p.shipId };
  if (kind === "warehouse_goods") return { port_id: p.portId, commodity_id: p.goodId, tons: num(p.tons) };
  if (kind === "contract_receivable") return { contract_id: p.contractId.trim() };
  if (kind === "deposit") return { deposit_id: p.depositId.trim() };
  return {};
}

export function pledgeProblem(kind: S.CollateralKind, p: Pledge): string | null {
  if (kind === "ship_lien") return p.shipId.trim() ? null : "Choose the ship to pledge.";
  if (kind === "warehouse_goods") {
    const t = num(p.tons);
    return !p.portId || !p.goodId ? "Choose the goods to pledge." : !(t > 0) ? "Enter the tons pledged." : null;
  }
  if (kind === "contract_receivable") return p.contractId.trim() ? null : "Enter the accepted contract's id.";
  if (kind === "deposit") return p.depositId.trim() ? null : "Choose the deposit to pledge.";
  return null;
}

/**
 * A deposit we may borrow against (guide 3.13.4): one of our own, open, not already pledged. Its free balance (less
 * withdrawals asked for) must cover the loan's total repayable, checked by the game when asked, quoted and approved.
 */
export const pledgeableDeposit = (d: S.DepositResult, companyId: string | undefined) =>
  d.depositor_company_id === companyId && d.status === "open" && d.pledged_pence <= 0 && d.balance_pence - d.pending_withdrawal_pence > 0;

/**
 * The pledge for a collateral kind. `ours`: our own ships and free warehouse stock (borrowing); otherwise the
 * borrower's (a direct offer), typed in by id.
 */
export function PledgeFields({
  kind,
  value,
  onChange,
  ours,
  ships,
  stock,
  pledged,
  deposits,
}: {
  kind: S.CollateralKind;
  value: Pledge;
  onChange: (p: Pledge) => void;
  ours: boolean;
  ships?: ShipResult[];
  /** Our warehouses (for goods we pledge). */
  stock?: S.PortWarehouseResult[];
  /** Ships already under a lien (left out of the picker). */
  pledged?: Map<string, S.Loan>;
  /** Our deposits that may secure a loan (a deposit pledge). */
  deposits?: S.DepositResult[];
}) {
  const { portName, goodName } = useCatalog();
  const set = (patch: Partial<Pledge>) => onChange({ ...value, ...patch });
  if (kind === "unsecured") return null;
  if (kind === "ship_lien") {
    return ours ? (
      <Field label="Ship pledged (lien)">
        <ShipSelect ships={ships} value={value.shipId} onChange={(v) => set({ shipId: v })} placeholder="Choose a ship…" filter={(r) => !pledged?.has(r.ship.id)} />
      </Field>
    ) : (
      <Field label="Borrower's ship id (lien)">
        <Input value={value.shipId} onChange={(e) => set({ shipId: e.target.value })} placeholder="ship id" />
      </Field>
    );
  }
  if (kind === "deposit") {
    return ours ? (
      <Field label="Deposit pledged (only its bank may quote)">
        <NativeSelect value={value.depositId} onChange={(e) => set({ depositId: e.target.value })}>
          <option value="">{deposits === undefined ? "Reading your deposits…" : deposits.length ? "Choose a deposit…" : "No open deposit free to pledge"}</option>
          {(deposits ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.bank_name} · {d.banking_region.replace(/_/g, " ")} · {fmtCr(d.balance_pence - d.pending_withdrawal_pence)} free
            </option>
          ))}
        </NativeSelect>
      </Field>
    ) : (
      <Field label="Borrower's deposit id">
        <Input value={value.depositId} onChange={(e) => set({ depositId: e.target.value })} placeholder="deposit id" />
      </Field>
    );
  }
  if (kind === "contract_receivable") {
    return (
      <Field label="Accepted freight contract or commission id">
        <Input value={value.contractId} onChange={(e) => set({ contractId: e.target.value })} placeholder="contract id" />
      </Field>
    );
  }
  // Goods.
  if (ours) {
    const rows = (stock ?? []).flatMap((w) =>
      w.inventory.map((i) => ({ port: w.port_id, good: i.commodity_id, free: Math.max(0, i.quantity - i.locked_quantity) })),
    ).filter((r) => r.free > 0);
    const key = value.portId && value.goodId ? `${value.portId}|${value.goodId}` : "";
    const picked = rows.find((r) => `${r.port}|${r.good}` === key);
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Goods pledged (free stock)">
          <NativeSelect
            value={key}
            onChange={(e) => {
              const [portId = "", goodId = ""] = e.target.value.split("|");
              set({ portId, goodId });
            }}
          >
            <option value="">{stock === undefined ? "Reading warehouses…" : rows.length ? "Choose goods…" : "No free stock"}</option>
            {rows.map((r) => (
              <option key={`${r.port}|${r.good}`} value={`${r.port}|${r.good}`}>
                {goodName(r.good)} at {portName(r.port)} · {fmtTons(r.free)} free
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={`Tons${picked ? ` (≤ ${fmtTons(picked.free)})` : ""}`}>
          <Input type="number" min={0} step="any" value={value.tons} onChange={(e) => set({ tons: e.target.value })} />
        </Field>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Port">
        <PortSelect value={value.portId} onChange={(v) => set({ portId: v })} placeholder="Port…" />
      </Field>
      <Field label="Good">
        <GoodSelect value={value.goodId} onChange={(v) => set({ goodId: v })} placeholder="Good…" />
      </Field>
      <Field label="Tons">
        <Input type="number" min={0} step="any" value={value.tons} onChange={(e) => set({ tons: e.target.value })} />
      </Field>
    </div>
  );
}

/** Our warehouses (for goods pledges), refreshed every minute. */
export function useStock() {
  return usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 60_000);
}

/** The region a port banks in. */
export function useRegionOf() {
  const { catalog } = useCatalog();
  return (portId: string | null | undefined) => (portId ? (catalog?.ports.find((p) => p.id === portId)?.banking_region ?? null) : null);
}
