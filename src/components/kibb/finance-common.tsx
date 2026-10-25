"use client";

// Pieces shared by the loans, banks, ventures and ship-shares pages (guide 3.13).

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KV, NativeSelect } from "@/components/kibb/bits";
import { Field, GoodSelect, PortSelect, REGIONS, ShipSelect } from "@/components/kibb/pickers";
import { fetchAll } from "@/components/kibb/trade-common";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtTons } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { FinanceReport } from "@/lib/kibb/fleet/manager";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult } from "@/lib/kibb/types";

// ── Rules (guide 3.13) ────────────────────────────────────────────────────────

/** Loan bounds: at least 100 Cr; 5..=150 bps a game day (10%..=300% of the Goldsmiths' 50); terms 1..=60 game days. */
export const LOAN = {
  minPrincipalPence: 10_000,
  rateMinBps: 5,
  rateMaxBps: 150,
  goldsmithsRateBps: 50,
  termMaxDays: 60,
  goldsmithsTermMaxDays: 30,
  goldsmithsMaxPence: 750_000,
  goldsmithsLtvBps: 4_000,
  /** Direct offers stand 1..=168 game hours (default 24); board entries 1..=720 (default 72). */
  offerHoursMax: 168,
  offerHoursDefault: 24,
  boardHoursMax: 720,
  boardHoursDefault: 72,
  ltvMaxBps: 10_000,
} as const;

/** Banks: 10,000 Cr fee, 50,000 Cr of own funds after it, 20% reserve, rates 0..=50 bps a day, notice 1..=720 game hours. */
export const BANK = {
  charterFeePence: 1_000_000,
  ownFundsPence: 5_000_000,
  reserveBps: 2_000,
  rateMaxBps: 50,
  noticeHoursMax: 720,
  minDepositPence: 1_000,
  insuredCoverPence: 250_000,
  insuredAfterDays: 14,
} as const;

/** Ventures: investors take 25%..=90% of the profit after 2% stamp duty; raise 1..=168 game hours (default 24); stakes ≥ 10 Cr. */
export const VENTURE = { shareMinBps: 2_500, shareMaxBps: 9_000, stampDutyBps: 200, raiseHoursMax: 168, raiseHoursDefault: 24, minStakePence: 1_000 } as const;

/** What a default does, in the guide's terms (3.13.1). */
export const DEFAULT_WARNING =
  "Not repaid by maturity, a loan defaults: a liened ship goes to the lender where it lies (credited at half its rebuild value) and is arrested until then (it can't depart or join a convoy, and your cargo left aboard is sold at half base price toward the debt); pledged goods move to the lender's warehouse; with recourse the rest is taken from your vaults daily. The default stays on your public credit record.";

/** Number input value → number; empty → NaN. */
export const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

/** Crowns typed into a field → pence (NaN stays NaN). */
export const crToPence = (v: string) => Math.round(num(v) * 100);

/** The first message whose condition fails, else null. */
export function firstProblem(checks: Array<[boolean, string]>): string | null {
  return checks.find(([ok]) => !ok)?.[1] ?? null;
}

/** Simple interest on `principal` at `rateBps` a game day over `days` (the most a loan run to term costs). */
export const interestFor = (principalPence: number, rateBps: number, days: number) => Math.ceil((principalPence * rateBps * days) / 10_000);

/** "50 bps/day" with the 30-day equivalent as a tooltip. */
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
 * Reads the public sources of company names every 5 minutes (every bank, every region's credit board, our own
 * companies) so loans, deposits and credit lookups can show names instead of ids.
 */
export function useCompanyDirectory() {
  const { data: ours } = usePoll(() => dash.get<{ companies: Array<{ id: string; name: string }> }>("/api/kibb/companies"), 300_000);
  const { data: banks } = usePoll(() => kibbGet<S.BankResult[]>("/v1/bank/list"), 300_000);
  const { data: boards } = usePoll(
    () => Promise.all(REGIONS.map((r) => kibbGet<S.CreditBoard>("/v1/loan/board", { banking_region: r }).catch(() => null))),
    300_000,
  );
  useLearnCompanies([
    ...(ours?.companies ?? []).map((c) => [c.id, c.name] as [string, string]),
    ...(banks ?? []).map((b) => [b.company_id, b.name] as [string, string]),
    ...(boards ?? []).flatMap((b) => [
      ...(b?.offers ?? []).map((o) => [o.lender_company_id, o.lender_name] as [string, string]),
      ...(b?.requests ?? []).map((q) => [q.borrower_company_id, q.borrower_name] as [string, string]),
    ]),
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

export interface FleetFinance {
  /** The autopilot is enabled for this company. */
  running: boolean;
  finance: FinanceReport | null;
  /** Ships it sails. */
  ships: Set<string>;
  /** What the autopilot took a loan for (it repays its own), or null when it isn't one of its loans. */
  purposeOf: (loanId: string) => string | null;
  /** One of the autopilot's idle-cash offers on the credit board. */
  isAutopilotOffer: (entryId: string) => boolean;
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
    isAutopilotOffer: (id) => !!finance?.offers.some((o) => o.id === id),
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

export const COLLATERAL_LABEL: Record<S.CollateralKind, string> = {
  ship_lien: "Ship lien",
  warehouse_goods: "Warehouse goods",
  contract_receivable: "Contract receivable",
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

/** A company's public credit record (guide 3.13.7). */
export function CreditRecordView({ report }: { report: S.CreditReport }) {
  const defaults = report.loans_defaulted > 0 || report.defaulted_open_loans > 0;
  const bad = defaults || !!report.bankrupt_at || report.futures_claims_open_pence > 0 || report.loans_written_off > 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{report.company_name}</span>
        <Badge variant={bad ? "error" : "success"} size="sm">
          {bad ? "blemished" : "clean"}
        </Badge>
        {report.bankrupt_at && <Badge variant="error" size="sm">bankrupt {fmtDateTime(report.bankrupt_at)}</Badge>}
      </div>
      <KV
        rows={[
          ["Owes now (active loans)", `${fmtCr(report.active_owed_pence)} on ${report.active_loans}`],
          ["Defaulted, still owed", report.defaulted_open_loans ? `${fmtCr(report.defaulted_owed_pence)} on ${report.defaulted_open_loans}` : "none"],
          ["Loans repaid", report.loans_repaid],
          ["Loans defaulted (ever)", report.loans_defaulted],
          ["Written off", report.loans_written_off ? `${report.loans_written_off} (${fmtCr(report.loan_written_off_pence)})` : "none"],
          ["Last default", report.last_default_at ? fmtDateTime(report.last_default_at) : "never"],
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
}

export const EMPTY_PLEDGE: Pledge = { shipId: "", portId: "", goodId: "", tons: "", contractId: "" };

/** The request fields a collateral kind needs. */
export function pledgeBody(kind: S.CollateralKind, p: Pledge) {
  if (kind === "ship_lien") return { ship_id: p.shipId };
  if (kind === "warehouse_goods") return { port_id: p.portId, commodity_id: p.goodId, tons: num(p.tons) };
  if (kind === "contract_receivable") return { contract_id: p.contractId.trim() };
  return {};
}

export function pledgeProblem(kind: S.CollateralKind, p: Pledge): string | null {
  if (kind === "ship_lien") return p.shipId.trim() ? null : "Choose the ship to pledge.";
  if (kind === "warehouse_goods") {
    const t = num(p.tons);
    return !p.portId || !p.goodId ? "Choose the goods to pledge." : !(t > 0) ? "Enter the tons pledged." : null;
  }
  if (kind === "contract_receivable") return p.contractId.trim() ? null : "Enter the accepted contract's id.";
  return null;
}

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
