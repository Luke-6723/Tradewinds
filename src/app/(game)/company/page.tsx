"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, PortSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

const FACTOR_FEE_PENCE = 75_000;
const MAX_FACTORS = 12;
/** The factor share of daily sprawl upkeep: 120 Cr × factors^1.3. */
const factorUpkeep = (n: number) => (n > 0 ? Math.round(12_000 * n ** 1.3) : 0);

function ProfilePanel({ profile }: { profile: S.CompanyProfileResult | undefined }) {
  const { portName } = useCatalog();
  if (!profile) return <Panel title="Company"><Loading /></Panel>;
  const c = profile.company;
  return (
    <Panel title="Company">
      <KV
        rows={[
          ["Name", c.name],
          ["Owner", profile.handle],
          ["Home port", portName(c.home_port_id)],
          ["Founded", fmtDateTime(c.created_at)],
          ["Ships", profile.fleet_count],
          ["Resident factors", profile.factor_ports.length],
          ["Crown prestige", c.crown_prestige.toLocaleString("en-GB")],
          ["Company id", <span key="id" className="font-mono text-xs">{c.id}</span>],
        ]}
      />
      <p className="mt-3 text-muted-foreground text-xs">
        Prestige is a score only: each 10 Cr earned from charters adds a point.{" "}
        <Link href="/companies" className="text-primary hover:underline">Switch or found a company</Link>
      </p>
    </Panel>
  );
}

function SettingsPanel() {
  const { data: settings, error, reload } = usePoll(() => kibbGet<S.CompanySettings>("/v1/company/settings"));
  const [auto, setAuto] = useState(true);
  const [reserveCr, setReserveCr] = useState(0);
  const act = useAction<S.CompanySettings>(() => void reload());

  useEffect(() => {
    if (!settings) return;
    setAuto(settings.auto_remit_for_bills);
    setReserveCr(settings.auto_remit_min_reserve_pence / 100);
  }, [settings]);

  if (!settings) return <Panel title="Settings">{error ? <ErrorNote error={error} /> : <Loading />}</Panel>;
  const reservePence = Math.round(reserveCr * 100);
  const changed = auto !== settings.auto_remit_for_bills || reservePence !== settings.auto_remit_min_reserve_pence;

  return (
    <Panel title="Settings">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() =>
            dash.patch<S.CompanySettings>("/api/kibb/company/settings", {
              auto_remit_for_bills: auto,
              auto_remit_min_reserve_pence: reservePence,
            }),
          );
        }}
      >
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            Auto-remit for bills
            <span className="block text-muted-foreground text-xs">
              When a region can&apos;t cover a bill (rent, upkeep, berth dues), top it up from your other regions, richest first, at the normal fee.
            </span>
          </span>
        </label>
        <Field label="Never take a region below (Cr)">
          <Input type="number" min={0} step={1} value={reserveCr} disabled={!auto} onChange={(e) => setReserveCr(Math.max(0, Number(e.target.value)))} />
        </Field>
        <ErrorNote error={act.error} />
        {act.result && !changed && <p className="text-sm">Saved.</p>}
        <Button type="submit" size="sm" disabled={act.busy || !changed}>
          {act.busy ? "Saving…" : "Save"}
        </Button>
        <p className="text-muted-foreground text-xs">Saving needs a short-lived key with account rights; the dashboard mints one, uses it once and revokes it.</p>
      </form>
    </Panel>
  );
}

function FactorsPanel({ onChange }: { onChange: () => void }) {
  const { portName } = useCatalog();
  const { data: factors, error, reload } = usePoll(() => kibbGet<string[]>("/v1/company/factors"), 60_000);
  const { data: clock } = usePoll(() => kibbGet<S.WorldClockResult>("/v1/world/clock"));
  const [port, setPort] = useState("");
  const done = () => {
    void reload();
    onChange();
  };
  const hire = useAction<S.FactorActionResult>(done);
  const dismiss = useAction<S.FactorActionResult>(done);

  const n = factors?.length ?? 0;
  const full = n >= MAX_FACTORS;

  return (
    <Panel title="Resident factors">
      <p className="mb-3 text-muted-foreground text-sm">
        A factor gives quay visibility at a port without a ship there: live full order book depth, Coffee House gossip, local charters and freight,
        sailings and port events. It also counts as presence for warehouse leases.
      </p>
      <ErrorNote error={error} />
      {!factors ? (
        <Loading />
      ) : factors.length === 0 ? (
        <Empty>No factors hired.</Empty>
      ) : (
        <Table head={["Port", ""]}>
          {factors.map((p) => (
            <tr key={p}>
              <td>
                <Link href={`/ports/${p}`} className="hover:underline">{portName(p)}</Link>
              </td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={dismiss.busy}
                  onClick={() => {
                    if (confirm(`Dismiss the factor at ${portName(p)}? The 750 Cr fee is not refunded.`)) {
                      void dismiss.run(() => kibbPost<S.FactorActionResult>("/v1/company/dismiss-factor", { port_id: p }));
                    }
                  }}
                >
                  Dismiss
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorNote error={dismiss.error} className="mt-2" />
      <form
        className="mt-4 space-y-3 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void hire.run(() => kibbPost<S.FactorActionResult>("/v1/company/hire-factor", { port_id: port }));
        }}
      >
        <Field label="Hire a factor at">
          <PortSelect
            value={port}
            onChange={setPort}
            placeholder="Choose a port…"
            maxPhase={clock?.unlocked_phase}
            filter={(id) => !factors?.includes(id)}
          />
        </Field>
        <KV
          rows={[
            ["One-off fee", fmtCr(FACTOR_FEE_PENCE)],
            ["Factor upkeep a game day", `${fmtCr(factorUpkeep(n))} → ${fmtCr(factorUpkeep(n + 1))}`],
            ["Factors", `${n} of ${MAX_FACTORS}`],
          ]}
        />
        <ErrorNote error={hire.error} />
        {hire.result && <p className="text-sm">Factor resident at {portName(hire.result.port_id)}.</p>}
        <Button type="submit" size="sm" disabled={hire.busy || !port || full}>
          {hire.busy ? "Hiring…" : full ? "Factor limit reached" : "Hire factor"}
        </Button>
        <p className="text-muted-foreground text-xs">
          Upkeep is billed daily from the home vault with fleet sprawl. If it goes unpaid the bailiff dismisses every factor.
        </p>
      </form>
    </Panel>
  );
}

function BankruptcyPanel({ name }: { name: string | undefined }) {
  const [typed, setTyped] = useState("");
  const act = useAction<S.DeclareBankruptcyResult>();
  const { portName } = useCatalog();

  return (
    <Panel title="Declare bankruptcy" className="border-destructive/40">
      <div className="space-y-3 text-sm">
        <p>
          Admiralty receivership liquidates everything this company owns, resets its prestige and gives it a 2,500 Cr grant and a new hoy,{" "}
          <em>HMS Phoenix</em>, at the home port. A bankrupt company trades on but <strong>never ranks again this season</strong>.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>No ship may be at sea, and no open freight, futures or insurance on either side.</li>
          <li>
            Stranded (no ships and liquid worth below the cost of a new hoy, at least 3,000 Cr), or insolvent (liquid worth plus the forced-sale
            value of every hull beyond one hoy below 2,500 Cr).
          </li>
          <li>At most once per player every 24 real hours. Unpaid futures claims forfeit the grant.</li>
          <li>The fleet autopilot is stopped first.</li>
        </ul>
        <Field label={<>Type <span className="font-mono">{name ?? "the company name"}</span> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
        <ErrorNote error={act.error} />
        {act.result && (
          <p>
            Receivership done. Grant {fmtCr(act.result.bailout_capital_pence)} at {portName(act.result.home_port_id)}
            {act.result.claims_written_off_pence > 0 && `; ${fmtCr(act.result.claims_written_off_pence)} of claims written off`}. Next bankruptcy
            allowed after {fmtDateTime(act.result.cooldown_until)}.
          </p>
        )}
        <Button
          variant="destructive"
          size="sm"
          disabled={act.busy || !name || typed.trim() !== name}
          onClick={() => {
            if (confirm(`Declare bankruptcy for ${name}? This cannot be undone.`)) {
              void act.run(() => dash.post<S.DeclareBankruptcyResult>("/api/kibb/company/bankruptcy", { confirm_name: typed.trim() }));
            }
          }}
        >
          {act.busy ? "Declaring…" : "Declare bankruptcy"}
        </Button>
      </div>
    </Panel>
  );
}

export default function CompanyPage() {
  const { data: profile, error, reload } = usePoll(() => kibbGet<S.CompanyProfileResult>("/v1/company/profile"), 30_000);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Company" subtitle="Profile, bill settings, resident factors and receivership." />
      <ErrorNote error={error} />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <ProfilePanel profile={profile} />
        <SettingsPanel />
        <FactorsPanel onChange={() => void reload()} />
      </div>
      <BankruptcyPanel name={profile?.company.name} />
    </div>
  );
}
