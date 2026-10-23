"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { usePoll } from "@/hooks/use-poll";
import { dash } from "@/lib/kibb/browser";
import { fmtDateTime, fmtIn } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

interface AccountView {
  player: S.Player;
  companies: S.Company[];
  session_key_id: string;
  session_expires_at: string | null;
  keys: S.ApiKey[];
  /** Stored dashboard key id → company name (the autopilot runs on these). */
  dashboard_keys: Record<string, string>;
}

type SignOutResult = { signed_out?: boolean };

const signOutIf = (r: SignOutResult) => {
  if (r.signed_out) window.location.href = "/login";
};

function keyState(k: S.ApiKey): { label: string; variant: "success" | "secondary" | "error" } {
  if (k.revoked_at) return { label: "revoked", variant: "error" };
  if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return { label: "expired", variant: "secondary" };
  return { label: "active", variant: "success" };
}

function KeysPanel({ view, onDone }: { view: AccountView; onDone: () => void }) {
  const [showDead, setShowDead] = useState(false);
  const revoke = useAction<SignOutResult & { key_id: string }>((r) => {
    signOutIf(r);
    onDone();
  });
  const companyName = (id: string | null | undefined) => (id ? (view.companies.find((c) => c.id === id)?.name ?? "other company") : "player (all companies)");
  const keys = view.keys
    .filter((k) => showDead || keyState(k).label === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  function onRevoke(k: S.ApiKey) {
    const autopilot = view.dashboard_keys[k.id];
    const own = k.id === view.session_key_id;
    const msg = own
      ? "This is the key this browser session signs in with. Revoking it signs you out. Continue?"
      : autopilot
        ? `This is the stored key the dashboard and fleet autopilot use for ${autopilot}. Revoking it stops the autopilot until you select the company again (which mints a new key). Continue?`
        : `Revoke key "${k.label}"? Anything using it stops working.`;
    if (confirm(msg)) void revoke.run(() => dash.post("/api/kibb/account/revoke", { key_id: k.id }));
  }

  return (
    <Panel
      title="API keys"
      action={
        <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <input type="checkbox" checked={showDead} onChange={(e) => setShowDead(e.target.checked)} />
          Show revoked and expired
        </label>
      }
    >
      <ErrorNote error={revoke.error} className="mb-3" />
      {keys.length === 0 ? (
        <Empty>No keys.</Empty>
      ) : (
        <Table head={["Label", "Bound to", "Scopes", "Created", "Expires", "", ""]}>
          {keys.map((k) => {
            const st = keyState(k);
            return (
              <tr key={k.id}>
                <td>
                  <div className="font-medium">{k.label}</div>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {k.id === view.session_key_id && <Badge variant="info" size="sm">this session</Badge>}
                    {view.dashboard_keys[k.id] && <Badge variant="warning" size="sm">autopilot · {view.dashboard_keys[k.id]}</Badge>}
                  </div>
                </td>
                <td className="text-muted-foreground">{companyName(k.company_id)}</td>
                <td className="max-w-64 text-muted-foreground text-xs">{k.scopes.join(", ")}</td>
                <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(k.created_at)}</td>
                <td className="whitespace-nowrap text-muted-foreground">{k.expires_at ? fmtIn(k.expires_at) : "never"}</td>
                <td>
                  <Badge variant={st.variant} size="sm">{st.label}</Badge>
                </td>
                <td className="text-right">
                  {st.label === "active" && (
                    <Button size="sm" variant="outline" disabled={revoke.busy} onClick={() => onRevoke(k)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

function RevokeAllPanel({ view, onDone }: { view: AccountView; onDone: () => void }) {
  const [companyId, setCompanyId] = useState("");
  const [keepCurrent, setKeepCurrent] = useState(true);
  const act = useAction<SignOutResult & { revoked_count: number }>((r) => {
    signOutIf(r);
    onDone();
  });
  const target = companyId ? view.companies.find((c) => c.id === companyId)?.name : "every company and the player";

  return (
    <Panel title="Revoke many keys">
      <div className="space-y-3 text-sm">
        <Field label="Keys bound to">
          <NativeSelect value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">All keys on the account</option>
            {view.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {!companyId && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={keepCurrent} onChange={(e) => setKeepCurrent(e.target.checked)} />
            Keep this session&apos;s key
          </label>
        )}
        <p className="text-muted-foreground text-xs">
          Use this if a key leaked. The dashboard&apos;s stored company keys are revoked too, so the fleet autopilot stops until you select each
          company again.
        </p>
        <ErrorNote error={act.error} />
        {act.result && <p>Revoked {act.result.revoked_count} key{act.result.revoked_count === 1 ? "" : "s"}.</p>}
        <Button
          variant="destructive"
          size="sm"
          disabled={act.busy}
          onClick={() => {
            const signOut = !companyId && !keepCurrent;
            if (confirm(`Revoke all keys for ${target}?${signOut ? " This signs you out." : ""}`)) {
              void act.run(() =>
                dash.post("/api/kibb/account/revoke-all", { company_id: companyId || undefined, keep_current_key: companyId ? true : keepCurrent }),
              );
            }
          }}
        >
          {act.busy ? "Revoking…" : "Revoke all"}
        </Button>
      </div>
    </Panel>
  );
}

function PassphrasePanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [revokeAll, setRevokeAll] = useState(false);
  const act = useAction<SignOutResult & S.ChangePassphraseResult>((r) => {
    setCurrent("");
    setNext("");
    setAgain("");
    signOutIf(r);
  });
  const mismatch = again.length > 0 && next !== again;
  const tooShort = next.length > 0 && (next.length < 8 || next.length > 128);

  return (
    <Panel title="Change passphrase">
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (revokeAll && !confirm("Revoke every key too? This signs you out and stops the fleet autopilot until you sign in and select each company again.")) return;
          void act.run(() =>
            dash.post("/api/kibb/account/passphrase", { current_passphrase: current, new_passphrase: next, revoke_all_keys: revokeAll }),
          );
        }}
      >
        <Field label="Current passphrase">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New passphrase (8–128 characters)">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="New passphrase again">
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={revokeAll} onChange={(e) => setRevokeAll(e.target.checked)} />
          <span>
            Also revoke every API key
            <span className="block text-muted-foreground text-xs">
              Do this if the old passphrase or a key leaked. It signs you out and kills the autopilot&apos;s stored keys.
            </span>
          </span>
        </label>
        {tooShort && <ErrorNote error="The new passphrase must be 8 to 128 characters." />}
        {mismatch && <ErrorNote error="The new passphrases don't match." />}
        <ErrorNote error={act.error} />
        {act.result && <p>Passphrase changed{act.result.keys_revoked_count ? `; ${act.result.keys_revoked_count} keys revoked` : ""}.</p>}
        <Button type="submit" size="sm" disabled={act.busy || !current || !next || next !== again || tooShort}>
          {act.busy ? "Changing…" : "Change passphrase"}
        </Button>
        <p className="text-muted-foreground text-xs">Sent straight to the game; the dashboard never stores your passphrase.</p>
      </form>
    </Panel>
  );
}

export default function AccountPage() {
  const { data: view, error, reload } = usePoll(() => dash.get<AccountView>("/api/kibb/account"), 60_000);

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader title="Account" subtitle="Your player login and the API keys on it." />
      <ErrorNote error={error} />
      {!view ? (
        !error && <Loading />
      ) : (
        <>
          <div className="grid items-start gap-4 xl:grid-cols-3">
            <Panel title="Player">
              <KV
                rows={[
                  ["Handle", view.player.handle],
                  ["Registered", fmtDateTime(view.player.created_at)],
                  ["Companies", `${view.companies.length} of 5`],
                  ["This session expires", view.session_expires_at ? fmtIn(view.session_expires_at) : "never"],
                  ["Player id", <span key="id" className="font-mono text-xs">{view.player.id}</span>],
                ]}
              />
            </Panel>
            <PassphrasePanel />
            <RevokeAllPanel view={view} onDone={() => void reload()} />
          </div>
          <KeysPanel view={view} onDone={() => void reload()} />
        </>
      )}
    </div>
  );
}
