"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, NativeSelect, PageHeader, Panel, Table } from "@/components/kibb/bits";
import { Field, PortSelect, ShipSelect } from "@/components/kibb/pickers";
import { AutopilotWarning, Checkbox, Pager, PAGE_SIZE, num, realTime, shortId, useAutopilotShips, useCompanyId, useCursor, useTimeScale } from "@/components/kibb/naval-common";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtCr, fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { ShipResult, WorldClock } from "@/lib/kibb/types";

const STATUS_VARIANT: Record<S.ConvoyStatus, "info" | "success" | "secondary" | "error"> = {
  forming: "info",
  sailing: "success",
  completed: "secondary",
  cancelled: "error",
};

const ADMISSION_LABEL: Record<S.ConvoyAdmission, string> = {
  open: "open to all",
  approval: "organizer approves",
  invite_only: "invite only",
};

function ConvoyCard({
  r,
  ourId,
  ships,
  autopilot,
  onChange,
}: {
  r: S.ConvoyResult;
  ourId: string | undefined;
  ships: ShipResult[] | undefined;
  autopilot: Set<string>;
  onChange: () => void;
}) {
  const { portName, shipClassName } = useCatalog();
  const c = r.convoy;
  const organizer = !!ourId && c.organizer_company_id === ourId;
  const forming = c.status === "forming";
  const shipName = (id: string) => ships?.find((s) => s.ship.id === id)?.ship.name;
  const act = useAction(onChange);

  // Join: our ships anchored at the origin and not already in a convoy.
  const [joinShip, setJoinShip] = useState("");
  const [asEscort, setAsEscort] = useState(false);
  const [invitee, setInvitee] = useState("");
  const canJoin = (s: ShipResult) =>
    s.ship.status === "anchored_roadstead" && s.ship.current_port_id === c.origin_port_id && !s.ship.convoy_id && !r.member_ship_ids.includes(s.ship.id);
  const joiner = ships?.find((s) => s.ship.id === joinShip && canJoin(s));
  const fee = !joiner || asEscort || organizer ? 0 : c.escort_fee_pence_per_ton * joiner.hold_capacity_tons;

  const membership = (path: string, shipId: string) => act.run(() => kibbPost<S.ConvoyMembershipResult>(path, { convoy_id: c.id, ship_id: shipId }));
  // Lloyd's may have priced a member's policy with the consorts: sailing without them voids it (guide 3.4), so ask first.
  async function detach(shipId: string, pending: boolean) {
    if (!pending) {
      const held = await kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { ship_id: shipId, limit: 20 }).catch(() => null);
      const p = held?.find((x) => x.status === "open" || x.status === "active");
      const ask = !held
        ? "This ship's insurance couldn't be read. If Lloyd's priced a policy on it with this convoy's consorts, sailing without them voids it. Detach anyway?"
        : p
          ? `${shipName(shipId) ?? "This ship"} holds an ${p.status} policy to ${portName(p.dest_port_id)}. If Lloyd's priced it with this convoy's consorts, sailing without them voids it. Detach anyway?`
          : null;
      if (ask && !confirm(ask)) return;
    }
    await membership("/v1/fleet/detach-convoy", shipId);
  }

  const memberRow = (m: S.ConvoyMemberInfo, pending: boolean) => {
    const ours = m.company_id === ourId;
    return (
      <tr key={`${pending ? "p" : "m"}-${m.ship_id}`}>
        <td>
          {ours ? (
            <Link href={`/fleet/${m.ship_id}`} className="font-medium hover:underline">{shipName(m.ship_id) ?? shortId(m.ship_id)}</Link>
          ) : (
            <span className="font-mono text-xs">{shortId(m.ship_id)}</span>
          )}
        </td>
        <td className="text-muted-foreground text-xs">{ours ? "You" : <span className="font-mono">{shortId(m.company_id)}</span>}</td>
        <td>{shipClassName(m.ship_class)} <span className="text-muted-foreground text-xs">({m.hull_category})</span></td>
        <td className="tabular-nums">{m.cannons_count}</td>
        <td>{m.is_escort ? <Badge variant="info" size="sm">escort</Badge> : <span className="text-muted-foreground text-xs">—</span>}</td>
        <td className="tabular-nums">{m.escort_fee_pence ? fmtCr(m.escort_fee_pence) : "—"}</td>
        <td className="text-xs">{m.status}</td>
        <td className="space-x-1 whitespace-nowrap text-right">
          {pending && organizer && (
            <>
              <Button size="sm" disabled={act.busy} onClick={() => membership("/v1/fleet/approve-convoy-request", m.ship_id)}>Approve</Button>
              <Button size="sm" variant="outline" disabled={act.busy} onClick={() => membership("/v1/fleet/reject-convoy-request", m.ship_id)}>Reject</Button>
            </>
          )}
          {forming && ours && (
            <Button size="sm" variant="outline" disabled={act.busy} onClick={() => void detach(m.ship_id, pending)}>
              {pending ? "Withdraw" : "Detach"}
            </Button>
          )}
          {!pending && forming && organizer && !ours && (
            <Button
              size="sm"
              variant="outline"
              disabled={act.busy}
              onClick={() => confirm("Remove this ship from the convoy? Its escort fee is refunded.") && membership("/v1/fleet/kick-convoy-member", m.ship_id)}
            >
              Kick
            </Button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-foreground">{c.name}</span>
          <Badge variant={STATUS_VARIANT[c.status]} size="sm">{c.status}</Badge>
          {organizer && <Badge variant="outline" size="sm">yours</Badge>}
          {c.visibility === "private" && <Badge variant="secondary" size="sm">private</Badge>}
        </span>
      }
      action={<span className="text-muted-foreground text-xs">{portName(c.origin_port_id)} → {portName(c.dest_port_id)}</span>}
    >
      <div className="space-y-4">
        <KV
          rows={[
            ["Organizer", organizer ? "You" : <span className="font-mono text-xs">{shortId(c.organizer_company_id)}</span>],
            [forming ? "Departs" : "Departed", `${fmtDateTime(c.departs_at)}${forming ? ` (${fmtIn(c.departs_at)})` : ""}`],
            ["Admission", ADMISSION_LABEL[c.admission]],
            ["Escort fee", c.escort_fee_pence_per_ton ? `${fmtCr(c.escort_fee_pence_per_ton, 2)} per ton of hold` : "none"],
            ...(c.min_speed_centiknots ? ([["Minimum speed", `${(c.min_speed_centiknots / 100).toFixed(1)} kn`]] as Array<[string, string]>) : []),
            ...(r.voyage
              ? ([
                  ["Convoy speed", `${(r.voyage.speed_centiknots / 100).toFixed(1)} kn (slowest member)`],
                  ["Arrives", `${fmtDateTime(r.voyage.estimated_arrival_at)} (${fmtIn(r.voyage.estimated_arrival_at)})`],
                ] as Array<[string, string]>)
              : []),
            ["Route", r.route_legs.map((l) => `${portName(l.to_node)} (${l.edge_class})`).join(" → ") || "—"],
          ]}
        />

        {r.members.length === 0 ? (
          <Empty>No members yet.</Empty>
        ) : (
          <Table head={["Ship", "Company", "Class", "Guns", "Role", "Fee", "Status", ""]}>{r.members.map((m) => memberRow(m, false))}</Table>
        )}

        {r.pending_requests.length > 0 && (
          <div>
            <div className="mb-1 font-medium text-muted-foreground text-xs">Join requests</div>
            <Table head={["Ship", "Company", "Class", "Guns", "Role", "Fee", "Status", ""]}>{r.pending_requests.map((m) => memberRow(m, true))}</Table>
          </div>
        )}

        {forming && (
          <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="font-medium text-sm">Join with a ship</div>
              {(ships ?? []).some(canJoin) ? (
                <>
                  <ShipSelect ships={ships} filter={canJoin} value={joinShip} onChange={setJoinShip} placeholder="Choose a ship anchored here…" />
                  <AutopilotWarning show={!!joinShip && autopilot.has(joinShip)} />
                  <Checkbox checked={asEscort} onChange={setAsEscort}>
                    As an escort (needs guns; pays no fee, shares the fees by cannon count)
                  </Checkbox>
                  {fee > 0 && <p className="text-muted-foreground text-xs">Escrows {fmtCr(fee)} now ({fmtTons(joiner?.hold_capacity_tons)} of hold), refunded if it doesn&apos;t sail or is lost.</p>}
                  <Button
                    size="sm"
                    disabled={act.busy || !joiner || (asEscort && joiner.ship.cannons_count === 0)}
                    onClick={() => act.run(() => kibbPost<S.ConvoyMembershipResult>("/v1/fleet/join-convoy", { convoy_id: c.id, ship_id: joinShip, as_escort: asEscort }))}
                  >
                    {c.admission === "approval" && !organizer ? "Request to join" : "Join"}
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Ships join from the roadstead at {portName(c.origin_port_id)}: anchor one there (not in another convoy) to join.
                </p>
              )}
            </div>
            {organizer && (
              <div className="space-y-2">
                <div className="font-medium text-sm">Invite a company</div>
                <Input value={invitee} onChange={(e) => setInvitee(e.target.value)} placeholder="Company id (uuid)" list={`invitees-${c.id}`} />
                <datalist id={`invitees-${c.id}`}>
                  {[...new Set([...r.members, ...r.pending_requests].map((m) => m.company_id))]
                    .filter((id) => id !== ourId)
                    .map((id) => <option key={id} value={id} />)}
                </datalist>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={act.busy || !/^[0-9a-f-]{36}$/i.test(invitee.trim())}
                  onClick={() => act.run(() => kibbPost<S.ConvoyInviteResult>("/v1/fleet/invite-to-convoy", { convoy_id: c.id, company_id: invitee.trim() }))}
                >
                  Invite
                </Button>
                {r.invited_company_ids.length > 0 && (
                  <p className="text-muted-foreground text-xs">Invited: {r.invited_company_ids.map(shortId).join(", ")}</p>
                )}
              </div>
            )}
          </div>
        )}

        <ErrorNote error={act.error} />
        {act.result !== null && typeof act.result === "object" && (
          <p className="text-sm">
            {"ship_id" in act.result
              ? (() => {
                  const m = act.result as S.ConvoyMembershipResult;
                  return `Ship ${shipName(m.ship_id) ?? shortId(m.ship_id)}: ${m.status}${m.escort_fee_pence ? `, escort fee ${fmtCr(m.escort_fee_pence)}` : ""}${m.estimated_arrival_at ? `; convoy arrives ${fmtIn(m.estimated_arrival_at)}` : ""}.`;
                })()
              : `Invited ${shortId((act.result as S.ConvoyInviteResult).company_id)}.`}
          </p>
        )}
      </div>
    </Panel>
  );
}

function CreateConvoy({ ships, autopilot, maxPhase, onDone }: { ships: ShipResult[] | undefined; autopilot: Set<string>; maxPhase: number; onDone: () => void }) {
  const { portName } = useCatalog();
  const [flagship, setFlagship] = useState("");
  const [name, setName] = useState("");
  const [dest, setDest] = useState("");
  const [muster, setMuster] = useState("120");
  const [admission, setAdmission] = useState<S.ConvoyAdmission>("approval");
  const [visibility, setVisibility] = useState<S.ConvoyVisibility>("public");
  const [minKn, setMinKn] = useState("");
  const [feeCr, setFeeCr] = useState("0");
  const timeScale = useTimeScale();
  const act = useAction<S.ConvoyResult>(onDone);
  const move = useAction(onDone);

  const ship = ships?.find((s) => s.ship.id === flagship);
  const from = ship?.ship.current_port_id ?? "";
  const minutes = num(muster);
  const locked = ship?.ship.status === "berthed" && !!ship.ship.turnaround_unlocks_at && Date.parse(ship.ship.turnaround_unlocks_at) > Date.now();
  const valid = !!ship && ship.ship.status === "anchored_roadstead" && !!dest && dest !== from && name.trim() !== "" && minutes >= 60 && minutes <= 4320;

  function submit() {
    const kn = num(minKn);
    void act.run(() =>
      kibbPost<S.ConvoyResult>("/v1/fleet/create-convoy", {
        name: name.trim(),
        flagship_id: flagship,
        dest_port_id: dest,
        depart_in_game_minutes: Math.round(minutes),
        admission,
        visibility,
        ...(Number.isFinite(kn) && kn > 0 ? { min_speed_centiknots: Math.round(kn * 100) } : {}),
        escort_fee_pence_per_ton: Math.max(0, Math.round((num(feeCr) || 0) * 100)),
      }),
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Flagship">
        <ShipSelect
          ships={ships}
          filter={(s) => (s.ship.status === "berthed" || s.ship.status === "anchored_roadstead") && !s.ship.convoy_id}
          value={flagship}
          onChange={(v) => {
            setFlagship(v);
            act.reset();
          }}
          placeholder="Choose a ship in port…"
        />
      </Field>
      <AutopilotWarning show={!!flagship && autopilot.has(flagship)} />
      {ship?.ship.status === "berthed" && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="text-muted-foreground">The flagship must wait in the roadstead at {portName(from)}.</p>
          <Button size="sm" variant="outline" disabled={move.busy || locked} onClick={() => move.run(() => kibbPost("/v1/fleet/offshore", { ship_id: flagship }))}>
            {locked ? `Locked ${fmtIn(ship.ship.turnaround_unlocks_at)}` : "Move to roadstead"}
          </Button>
          <ErrorNote error={move.error} />
        </div>
      )}
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Baltic timber run" />
      </Field>
      <Field label="Bound for">
        <PortSelect value={dest} onChange={setDest} placeholder="Choose a port…" maxPhase={maxPhase} filter={(p) => p !== from} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Muster (game min)">
          <Input type="number" min={60} max={4320} value={muster} onChange={(e) => setMuster(e.target.value)} />
        </Field>
        <Field label="Escort fee (Cr/t)">
          <Input type="number" min={0} step={0.01} value={feeCr} onChange={(e) => setFeeCr(e.target.value)} />
        </Field>
        <Field label="Admission">
          <NativeSelect value={admission} onChange={(e) => setAdmission(e.target.value as S.ConvoyAdmission)}>
            <option value="open">Open</option>
            <option value="approval">Approval</option>
            <option value="invite_only">Invite only</option>
          </NativeSelect>
        </Field>
        <Field label="Visibility">
          <NativeSelect value={visibility} onChange={(e) => setVisibility(e.target.value as S.ConvoyVisibility)}>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </NativeSelect>
        </Field>
        <Field label="Min speed (kn, optional)" className="col-span-2">
          <Input type="number" min={0} step={0.1} value={minKn} onChange={(e) => setMinKn(e.target.value)} placeholder="none" />
        </Field>
      </div>
      <p className="text-muted-foreground text-xs">
        Musters for {Number.isFinite(minutes) ? `${Math.round(minutes)} game minutes (${realTime(minutes, timeScale)})` : "—"}, clamped to 1 game hour..3 game days.
      </p>
      <ErrorNote error={act.error} />
      {act.result && (
        <p className="text-sm">
          Convoy {act.result.convoy.name} forming, departs {fmtIn(act.result.convoy.departs_at)}.
        </p>
      )}
      <Button className="w-full" disabled={!valid || act.busy} onClick={submit}>
        {act.busy ? "Organizing…" : "Organize convoy"}
      </Button>
    </div>
  );
}

export default function ConvoysPage() {
  const ourId = useCompanyId();
  const autopilot = useAutopilotShips();
  const [port, setPort] = useState("");
  const [status, setStatus] = useState<S.ConvoyStatus | "">("forming");
  const pager = useCursor();
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"));
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 15_000);
  const { data: convoys, error, reload } = usePoll(
    () => kibbGet<S.ConvoyResult[]>("/v1/fleet/convoys", { port_id: port, status, cursor: pager.cursor, limit: PAGE_SIZE }),
    15_000,
    [port, status, pager.cursor],
  );
  const reloadAll = () => {
    void reload();
    void reloadShips();
  };
  const rows = convoys?.map((r) => ({ ...r, id: r.convoy.id }));

  return (
    <div className="space-y-5 pb-8 sm:space-y-6">
      <PageHeader
        title="Convoys"
        subtitle="Sail together for pooled guns and mutual aid. A convoy is never faster than its slowest ship."
        actions={
          <>
            <div className="w-full sm:w-48">
              <PortSelect
                value={port}
                onChange={(v) => {
                  setPort(v);
                  pager.reset();
                }}
                placeholder="All origin ports"
                maxPhase={clock?.unlocked_phase}
              />
            </div>
            <div className="w-full sm:w-36">
              <NativeSelect
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as S.ConvoyStatus | "");
                  pager.reset();
                }}
              >
                <option value="">Any status</option>
                <option value="forming">Forming</option>
                <option value="sailing">Sailing</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </NativeSelect>
            </div>
          </>
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ErrorNote error={error} />
          {!convoys ? (
            !error && <Loading />
          ) : convoys.length === 0 ? (
            <Panel title="Convoys">
              <Empty>No {status || ""} convoys{port ? " from this port" : ""}.</Empty>
            </Panel>
          ) : (
            convoys.map((r) => <ConvoyCard key={r.convoy.id} r={r} ourId={ourId} ships={ships} autopilot={autopilot} onChange={reloadAll} />)
          )}
          <Pager pager={pager} rows={rows} />
        </div>

        <div className="space-y-4">
          <Panel title="Organize a convoy">
            <CreateConvoy ships={ships} autopilot={autopilot} maxPhase={clock?.unlocked_phase ?? 1} onDone={reloadAll} />
          </Panel>
          <Panel title="How convoys work">
            <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground text-xs">
              <li>Ships muster in the roadstead at the origin and sail together at the departure time; members can&apos;t dock or depart alone meanwhile.</li>
              <li>No speed bonus: the convoy sails at its slowest member&apos;s speed. A minimum speed refuses (and at departure leaves behind) slower joiners.</li>
              <li>Every member&apos;s guns count against piracy. Each ship still rolls its own storms and eats its own stores.</li>
              <li>Rescue: when a storm would sink a member, consorts rated for that zone may save it (heavy cargo and stores losses).</li>
              <li>Salvage: if a member sinks, others recover part of its cargo (not sealed freight); the owner&apos;s share goes to its warehouse at the destination, as far as leased space allows.</li>
              <li>Escort fees: other companies&apos; paying ships escrow fee × hold on joining; armed escorts pay nothing and split the fees by cannon count on arrival.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
