"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { atPort } from "@/components/kibb/deals-common";
import { CashLine, WarnBox, regionName, useRegionOf, useShips, useVaults } from "@/components/kibb/finance-common";
import { Field, PortSelect } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, dash, kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

const FACTOR_FEE_PENCE = 75_000;
const MAX_FACTORS = 12;
/** The factor share of daily sprawl upkeep: 120 Cr × factors^1.25. */
const factorUpkeep = (n: number) => (n > 0 ? Math.round(12_000 * n ** 1.25) : 0);
/** Moving the home port (guide 3.12): 2,500 Cr from the new home region's vault to its Crown, at most once per real day. */
const RELOCATE_FEE_PENCE = 250_000;

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
  const { catalog, portName } = useCatalog();
  // No factor may be hired at a smugglers' cove (403 no_factor_at_cove, guide 3.12).
  const isCove = (id: string) => !!catalog?.ports.find((p) => p.id === id)?.is_cove;
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
            filter={(id) => !factors?.includes(id) && !isCove(id)}
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
        <Button type="submit" size="sm" disabled={hire.busy || !port || full || isCove(port)}>
          {hire.busy ? "Hiring…" : full ? "Factor limit reached" : isCove(port) ? "No factor at a cove" : "Hire factor"}
        </Button>
        <p className="text-muted-foreground text-xs">
          Upkeep is billed daily from the home vault with fleet sprawl. If it goes unpaid the bailiff dismisses every factor.
        </p>
      </form>
    </Panel>
  );
}

function MoveHomePanel({ profile, onMoved }: { profile: S.CompanyProfileResult | undefined; onMoved: () => void }) {
  const { catalog, portName } = useCatalog();
  const regionOf = useRegionOf();
  const vaults = useVaults();
  const { data: ships } = useShips();
  const { data: clock } = usePoll(() => kibbGet<S.WorldClockResult>("/v1/world/clock"));
  const [port, setPort] = useState("");
  const [next, setNext] = useState<string | null>(null);
  // Resolves to null when the confirmation is declined.
  const act = useAction<S.RelocateHomePortResult | null>((r) => {
    if (!r) return;
    setNext(r.next_relocation_at);
    setPort("");
    void vaults.reload();
    onMoved();
  });
  const home = profile?.company.home_port_id;
  const unlocked = clock?.unlocked_phase ?? 1;
  const isCove = (id: string) => !!catalog?.ports.find((p) => p.id === id)?.is_cove;
  // Presence: a ship of ours berthed or in the roadstead there, or a Resident Factor; never a cove.
  const presence = new Set<string>([...(ships ?? []).filter(atPort).map((r) => r.ship.current_port_id as string), ...(profile?.factor_ports ?? [])]);
  const eligible = (id: string) => presence.has(id) && id !== home && !isCove(id);
  const choices = (catalog?.ports ?? []).filter((p) => p.phase <= unlocked && eligible(p.id));
  const region = regionOf(port);
  const cash = vaults.cash(region);
  const soon = next !== null && Date.parse(next) > Date.now();

  function move() {
    if (!port || !home) return;
    void act.run(async () => {
      if (
        !confirm(
          `Move your home port from ${portName(home)} (${regionName(regionOf(home))}) to ${portName(port)} (${regionName(region)})?\n\n${fmtCr(RELOCATE_FEE_PENCE)} is paid from your ${regionName(region)} vault to its Crown. From then on your sprawl upkeep is billed there every day, and marques, patrols and R&D are paid from that vault; your licence deals and ship-share dividends are in that region, and Goldsmiths' quotes default to it. Bills already paid stay paid, and a chartered bank keeps the region it was chartered in. You may move again after one real day.`,
        )
      )
        return null;
      try {
        return await kibbPost<S.RelocateHomePortResult>("/v1/company/relocate", { port_id: port });
      } catch (e) {
        if (e instanceof DashboardApiError && e.status === 409) throw new Error(`You may move your home once per real day: ${e.detail}`);
        if (e instanceof DashboardApiError && e.status === 403)
          throw new Error(`You need a Resident Factor at ${portName(port)}, or a ship berthed or in its roadstead: ${e.detail}`);
        if (e instanceof DashboardApiError && e.code === "insufficient_funds")
          throw new Error(`Your ${regionName(region)} vault can't pay the ${fmtCr(RELOCATE_FEE_PENCE)} fee: remit cash there first. ${e.detail}`);
        throw e;
      }
    });
  }

  return (
    <Panel title="Move the home port">
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Your home port&apos;s region is where sprawl upkeep is billed every day, so cash must be kept there. A company whose trade has moved can move its home
          to any open port where it has presence, except a smugglers&apos; cove.
        </p>
        <KV
          rows={[
            ["Home now", home ? `${portName(home)} (${regionName(regionOf(home))})` : "…"],
            ["Fee", `${fmtCr(RELOCATE_FEE_PENCE)}, from the new home region's vault`],
            ["How often", soon ? `next move ${fmtIn(next)}` : "once per real day (the game says when if it is too soon)"],
          ]}
        />
        <Field label="New home (a ship of yours in port there, or a factor)">
          <PortSelect value={port} onChange={setPort} placeholder={choices.length ? "Choose a port…" : "No other port with presence"} maxPhase={unlocked} filter={eligible} />
        </Field>
        {port && (
          <>
            <CashLine region={region} cash={cash} need={RELOCATE_FEE_PENCE} />
            <WarnBox tone="info">
              <p>
                Follows the new home ({regionName(region)}): the daily sprawl upkeep bill, and payment for marques, patrols and R&amp;D; your licence deals and the
                dividends you pay on ship shares; the default region of Goldsmiths&apos; quotes; where a receivership&apos;s grant hoy appears.
              </p>
              <p>Stays as it is: bills already paid, and the region of a bank you chartered.</p>
            </WarnBox>
          </>
        )}
        <ErrorNote error={act.error} />
        {act.result && (
          <p className="text-sm">
            Home moved from {portName(act.result.from_port_id)} to {portName(act.result.to_port_id)} for {fmtCr(act.result.fee_pence)}. Next move allowed{" "}
            {fmtDateTime(act.result.next_relocation_at)}.
          </p>
        )}
        <Button size="sm" disabled={act.busy || !port || !home || soon || (cash !== undefined && cash < RELOCATE_FEE_PENCE)} onClick={move}>
          {act.busy ? "Moving…" : port ? `Move home to ${portName(port)} for ${fmtCr(RELOCATE_FEE_PENCE)}` : "Move home"}
        </Button>
      </div>
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
      <PageHeader title="Company" subtitle="Profile, bill settings, resident factors, the home port and receivership." />
      <ErrorNote error={error} />
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <ProfilePanel profile={profile} />
        <SettingsPanel />
        <FactorsPanel onChange={() => void reload()} />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <MoveHomePanel profile={profile} onMoved={() => void reload()} />
        <div className="xl:col-span-2">
          <BankruptcyPanel name={profile?.company.name} />
        </div>
      </div>
    </div>
  );
}
