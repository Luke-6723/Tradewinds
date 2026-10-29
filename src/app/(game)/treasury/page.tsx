"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, REGIONS, RegionSelect } from "@/components/kibb/pickers";
import { LoadMore, usePaged } from "@/components/kibb/company-paged";
import { useCompanyId } from "@/components/kibb/naval-common";
import { useAction } from "@/hooks/use-action";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtBps, fmtCr, fmtDateTime } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

const regionName = (r: string) => r.replace(/_/g, " ");

interface Draft {
  bank: S.BankResult;
  /** Its posted fee into the destination less the client discount it gives us, never below 0. */
  feeBps: number;
}

/**
 * Open banks that would carry a remittance into `to` as a draft (guide 3.12): a fee posted for `to`, less the client discount
 * the bank gives us, strictly below the Crown's fee for the route; cheapest first. Never our own bank. Whether one has the
 * cash in its `to` vault isn't public: if none does, the Crown carries it.
 */
function draftsFor(
  banks: S.BankResult[] | undefined,
  terms: S.ClientTermsResult[] | undefined,
  companyId: string | undefined,
  to: string,
  crownBps: number | undefined,
): Draft[] {
  if (crownBps === undefined) return [];
  const discount = (bankId: string) => terms?.find((t) => t.bank_company_id === bankId && t.depositor_company_id === companyId)?.exchange_discount_bps ?? 0;
  return (banks ?? [])
    .filter((b) => b.status === "open" && !b.failed_at && b.company_id !== companyId && b.exchange_fee_bps?.[to] !== undefined)
    .map((b) => ({ bank: b, feeBps: Math.max(0, b.exchange_fee_bps[to] - discount(b.company_id)) }))
    .filter((d) => d.feeBps < crownBps)
    .sort((a, b) => a.feeBps - b.feeBps);
}

/** Every region the API lists, in the usual order, any region not in REGIONS (a new one) after them: none is hidden. */
function regionsIn(ids: Iterable<string>): string[] {
  const order = (r: string) => {
    const i = (REGIONS as string[]).indexOf(r);
    return i < 0 ? REGIONS.length : i;
  };
  return [...new Set(ids)].filter(Boolean).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

function VaultsPanel({ vaults }: { vaults: S.VaultBalanceResult[] | undefined }) {
  if (!vaults) return <Panel title="Vaults"><Loading /></Panel>;
  const by = (region: string, type: S.AccountType) => vaults.find((v) => v.banking_region === region && v.account_type === type)?.balance_pence ?? 0;
  const regions = regionsIn(vaults.map((v) => v.banking_region));
  const total = (type: S.AccountType) => vaults.filter((v) => v.account_type === type).reduce((n, v) => n + v.balance_pence, 0);
  return (
    <Panel title="Vaults">
      {regions.length === 0 ? (
        <Empty>No vaults yet.</Empty>
      ) : (
        <Table head={["Region", "Vault", "Escrow", ""]}>
          {regions.map((r) => {
            const cash = by(r, "vault");
            return (
              <tr key={r}>
                <td className="capitalize">{regionName(r)}</td>
                <td className={`tabular-nums ${cash < 0 ? "text-destructive" : ""}`}>{fmtCr(cash, 2)}</td>
                <td className="text-muted-foreground tabular-nums">{fmtCr(by(r, "escrow"), 2)}</td>
                <td>{cash < 0 && <Badge variant="error" size="sm">debt</Badge>}</td>
              </tr>
            );
          })}
          <tr className="font-medium">
            <td>Total</td>
            <td className="tabular-nums">{fmtCr(total("vault"), 2)}</td>
            <td className="text-muted-foreground tabular-nums">{fmtCr(total("escrow"), 2)}</td>
            <td />
          </tr>
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        Escrow holds resting bids, freight collateral, futures margin and insurance premiums or collateral; it isn&apos;t spendable until released.
        A negative vault is debt the bailiff collects.
      </p>
    </Panel>
  );
}

function RatesPanel({
  rates,
  banks,
  terms,
  companyId,
}: {
  rates: S.RegionalAchRateResult[] | undefined;
  banks: S.BankResult[] | undefined;
  terms: S.ClientTermsResult[] | undefined;
  companyId: string | undefined;
}) {
  if (!rates) return <Panel title="Remittance fees"><Loading /></Panel>;
  const regions = regionsIn(rates.flatMap((x) => [x.from_region, x.to_region]));
  const fee = (from: string, to: string) => rates.find((x) => x.from_region === from && x.to_region === to)?.fee_bps;
  return (
    <Panel title="Remittance fees (from row to column)">
      {regions.length === 0 ? (
        <Empty>No rates published.</Empty>
      ) : (
        <Table head={["From \\ to", ...regions.map((r) => <span key={r} className="capitalize">{regionName(r)}</span>)]}>
          {regions.map((from) => (
            <tr key={from}>
              <td className="capitalize text-muted-foreground">{regionName(from)}</td>
              {regions.map((to) => {
                const draft = from === to ? undefined : draftsFor(banks, terms, companyId, to, fee(from, to))[0];
                return (
                  <td key={to} className="tabular-nums">
                    {from === to ? "—" : fmtBps(fee(from, to))}
                    {draft && (
                      <div className="text-success-foreground text-xs" title={`${draft.bank.name} posts ${fmtBps(draft.feeBps)} into ${regionName(to)}: it carries the remittance as a draft if its vault there has the cash`}>
                        draft {fmtBps(draft.feeBps)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-muted-foreground text-xs">
        The Crown&apos;s live fees. &ldquo;Draft&rdquo;: the cheapest open bank whose exchange fee into that region (less any client discount it gives you) is strictly
        below the Crown&apos;s; it carries your remittance there if its vault in that region already holds the cash.
      </p>
    </Panel>
  );
}

function RemitPanel({
  vaults,
  rates,
  banks,
  terms,
  companyId,
  onDone,
}: {
  vaults: S.VaultBalanceResult[] | undefined;
  rates: S.RegionalAchRateResult[] | undefined;
  banks: S.BankResult[] | undefined;
  terms: S.ClientTermsResult[] | undefined;
  companyId: string | undefined;
  onDone: () => void;
}) {
  const [from, setFrom] = useState<string>("channel");
  const [to, setTo] = useState<string>("north_sea");
  const [amountCr, setAmountCr] = useState(100);
  const act = useAction<S.RemittanceResult>(() => onDone());
  const available = vaults?.find((v) => v.banking_region === from && v.account_type === "vault")?.balance_pence ?? 0;
  const gross = Math.round(amountCr * 100);
  const feeBps = rates?.find((r) => r.from_region === from && r.to_region === to)?.fee_bps;
  const fee = feeBps === undefined ? undefined : Math.round((gross * feeBps) / 10_000);
  // Who would carry it: the cheapest bank under the Crown's fee, if it has the cash there; else the Crown.
  const drafts = from === to ? [] : draftsFor(banks, terms, companyId, to, feeBps);
  const draft = drafts[0];
  const draftFee = draft ? Math.round((gross * draft.feeBps) / 10_000) : undefined;
  const tied = draft ? drafts.filter((d) => d.feeBps === draft.feeBps).length : 0;
  const r = act.result;

  return (
    <Panel title="Remit between regions">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() =>
            kibbPost<S.RemittanceResult>("/v1/treasury/remit", { from_region: from, to_region: to, gross_amount_pence: gross }),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <RegionSelect value={from} onChange={setFrom} />
          </Field>
          <Field label="To">
            <RegionSelect value={to} onChange={setTo} />
          </Field>
          <Field label="Amount (Cr)" className="col-span-2">
            <Input type="number" min={0.01} step={0.01} value={amountCr} onChange={(e) => setAmountCr(Number(e.target.value))} />
          </Field>
        </div>
        <KV
          rows={[
            ["Available in the from vault", fmtCr(available, 2)],
            [`Crown's fee${feeBps !== undefined ? ` ${fmtBps(feeBps)}` : ""}`, fee === undefined ? "no rate listed" : `≈ ${fmtCr(fee, 2)}`],
            [
              "Cheapest bank draft",
              draft
                ? `${draft.bank.name} at ${fmtBps(draft.feeBps)}: ≈ ${fmtCr(draftFee, 2)}${fee !== undefined && draftFee !== undefined ? `, saving ≈ ${fmtCr(fee - draftFee, 2)}` : ""}`
                : feeBps === undefined || from === to
                  ? "—"
                  : "none under the Crown's fee",
            ],
            [
              "Credited",
              fee === undefined ? "—" : draftFee !== undefined ? `≈ ${fmtCr(gross - draftFee, 2)} by draft, else ≈ ${fmtCr(gross - fee, 2)}` : `≈ ${fmtCr(gross - fee, 2)}`,
            ],
          ]}
        />
        {draft && (
          <p className="text-muted-foreground text-xs">
            You don&apos;t choose the carrier: {draft.bank.name} carries it as a draft only if its {regionName(to)} vault already holds the amount less its fee
            {tied > 1 ? ` (${tied} banks tie at this fee: the one whose schedule has gone longest unchanged wins)` : ""}; otherwise the next cheapest such bank, or the
            Crown at its fee. On a draft you pay the whole amount into the bank&apos;s {regionName(from)} vault and it pays you the rest in {regionName(to)}.
          </p>
        )}
        <ErrorNote error={act.error} />
        {r && (
          <p className="text-sm">
            Sent {fmtCr(r.gross_amount_pence, 2)}; {fmtCr(r.net_credited_pence, 2)} credited after a {fmtCr(r.fee_pence, 2)} fee ({fmtBps(r.fee_bps)}),{" "}
            {r.carried_by === "bank" ? (
              <>
                carried by {r.bank_name ?? "a bank"} as a draft: the Crown would have charged {fmtCr(r.crown_fee_pence, 2)} ({fmtBps(r.crown_fee_bps)}), so you saved{" "}
                <span className="font-medium text-success-foreground">{fmtCr(r.crown_fee_pence - r.fee_pence, 2)}</span>.
              </>
            ) : (
              "carried by the Crown."
            )}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={act.busy || from === to || gross <= 0 || gross > available}>
          {act.busy ? "Sending…" : from === to ? "Pick two regions" : gross > available ? "Not enough in that vault" : `Remit ${fmtCr(gross)}`}
        </Button>
        <p className="text-muted-foreground text-xs">
          You never choose the carrier: a bank whose posted fee into the destination (less your client discount) is strictly below the Crown&apos;s, and which has
          the cash there, carries it as a draft; otherwise the Crown does. Auto-remittances for bills always go by the Crown. Hub mints also buy and sell silver
          bullion at fixed prices with no customs: carrying silver between hubs avoids the fee.
        </p>
      </form>
    </Panel>
  );
}

function LedgerPanel({ vaults, refreshKey }: { vaults: S.VaultBalanceResult[] | undefined; refreshKey: number }) {
  const [region, setRegion] = useState("");
  const [reason, setReason] = useState("");
  const [reasonInput, setReasonInput] = useState("");
  const page = usePaged<S.LedgerEntry>(
    (cursor, limit) => kibbGet<S.LedgerEntry[]>("/v1/treasury/ledger", { cursor, limit, banking_region: region, reason }),
    [region, reason, refreshKey],
  );
  const mine = useMemo(() => new Map((vaults ?? []).map((v) => [v.account_id, `${v.account_type} · ${regionName(v.banking_region)}`])), [vaults]);
  const reasons = useMemo(() => [...new Set(page.items.map((e) => e.reason))].sort(), [page.items]);
  const label = (id: string) => mine.get(id) ?? "outside";

  return (
    <Panel title="Ledger">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Region" className="w-full sm:w-44">
          <RegionSelect value={region} onChange={setRegion} placeholder="All regions" />
        </Field>
        <Field label="Reason" className="w-full sm:w-56">
          <Input
            list="ledger-reasons"
            value={reasonInput}
            placeholder="Any reason"
            onChange={(e) => setReasonInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setReason(reasonInput.trim())}
            onBlur={() => setReason(reasonInput.trim())}
          />
          <datalist id="ledger-reasons">
            {reasons.map((r) => <option key={r} value={r} />)}
          </datalist>
        </Field>
      </div>
      <ErrorNote error={page.error} />
      {page.items.length === 0 ? (
        page.loading ? <Loading /> : <Empty>No entries.</Empty>
      ) : (
        <Table head={["When", "Reason", "From", "To", "Amount"]}>
          {page.items.map((e) => {
            const inbound = mine.has(e.credit_account_id) && !mine.has(e.debit_account_id);
            const outbound = mine.has(e.debit_account_id) && !mine.has(e.credit_account_id);
            return (
              <tr key={e.id}>
                <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(e.created_at)}</td>
                <td>{e.reason.replace(/_/g, " ")}</td>
                <td className="text-muted-foreground capitalize">{label(e.debit_account_id)}</td>
                <td className="text-muted-foreground capitalize">{label(e.credit_account_id)}</td>
                <td className={`whitespace-nowrap tabular-nums ${inbound ? "text-success-foreground" : outbound ? "text-destructive" : ""}`}>
                  {inbound ? "+" : outbound ? "−" : ""}
                  {fmtCr(e.amount_pence, 2)}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <LoadMore loading={page.loading} done={page.done} onClick={page.loadMore} count={page.items.length} />
    </Panel>
  );
}

export default function TreasuryPage() {
  const { data: vaults, error, reload } = usePoll(() => kibbGet<S.TreasuryVaultsResult>("/v1/treasury/vaults"), 15_000);
  const { data: rates } = usePoll(() => kibbGet<S.RegionalAchRateResult[]>("/v1/treasury/rates"), 300_000);
  // Banks' exchange schedules and the client terms they give us: who would carry a remittance as a draft.
  const { data: banks } = usePoll(() => kibbGet<S.BankResult[]>("/v1/bank/list"), 60_000);
  const { data: terms } = usePoll(() => kibbGet<S.ClientTermsResult[]>("/v1/bank/client-terms"), 120_000);
  const companyId = useCompanyId();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Treasury" subtitle="Cash is held per banking region. Payments at a port come from that region's vault; daily upkeep from the home vault." />
      <ErrorNote error={error} />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <VaultsPanel vaults={vaults?.vaults} />
        <RemitPanel
          vaults={vaults?.vaults}
          rates={rates}
          banks={banks}
          terms={terms}
          companyId={companyId}
          onDone={() => {
            void reload();
            setRefreshKey((k) => k + 1);
          }}
        />
      </div>
      <RatesPanel rates={rates} banks={banks} terms={terms} companyId={companyId} />
      <LedgerPanel vaults={vaults?.vaults} refreshKey={refreshKey} />
    </div>
  );
}
