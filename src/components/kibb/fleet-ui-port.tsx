"use client";

// Port page panels: Resident Factor, warehouse lease, port events.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, ErrorNote, KV, Loading, Panel, Table } from "@/components/kibb/bits";
import { Field } from "@/components/kibb/pickers";
import { useAction } from "@/hooks/use-action";
import { useCatalog } from "@/hooks/use-catalog";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet, kibbPost } from "@/lib/kibb/browser";
import { fmtDateTime, fmtIn, fmtTons } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";
import type { PortDetail } from "@/lib/kibb/types";

export function FactorPanel({ port, onChange }: { port: PortDetail; onChange: () => void }) {
  const { data: factors, reload } = usePoll(() => kibbGet<string[]>("/v1/company/factors"), 60_000);
  const act = useAction<S.FactorActionResult>(() => {
    void reload();
    onChange();
  });
  const has = factors?.includes(port.id) ?? false;

  function hire() {
    if (!confirm(`Hire a Resident Factor at ${port.name} for 750 Cr, plus daily upkeep from your home vault?`)) return;
    void act.run(() => kibbPost<S.FactorActionResult>("/v1/company/hire-factor", { port_id: port.id }));
  }
  function dismiss() {
    if (!confirm(`Dismiss the factor at ${port.name}? The 750 Cr fee is not refunded.`)) return;
    void act.run(() => kibbPost<S.FactorActionResult>("/v1/company/dismiss-factor", { port_id: port.id }));
  }

  return (
    <Panel title="Resident Factor">
      <div className="space-y-3 text-sm">
        {!factors ? (
          <Loading />
        ) : (
          <KV
            rows={[
              ["Here", has ? <Badge key="f" variant="success" size="sm">hired</Badge> : "none"],
              ["Your factors", `${factors.length} / 12`],
            ]}
          />
        )}
        <p className="text-muted-foreground text-xs">
          A factor gives quay visibility without a ship: full book depth, gossip, local charters and freight, and lets you lease
          warehouse space or quote ships. 750 Cr once, plus upkeep (120 Cr × factors^1.3 a game day, shared with the fleet bill).
        </p>
        <ErrorNote error={act.error} />
        {has ? (
          <Button size="sm" variant="outline" disabled={act.busy} onClick={dismiss}>
            Dismiss factor
          </Button>
        ) : (
          <Button size="sm" disabled={act.busy || !factors || factors.length >= 12} onClick={hire}>
            Hire factor (750 Cr)
          </Button>
        )}
      </div>
    </Panel>
  );
}

export function LeasePanel({ port, onChange }: { port: PortDetail; onChange: () => void }) {
  const { goodName } = useCatalog();
  const { data: wh, error, reload } = usePoll(() => kibbGet<S.PortWarehouseResult>("/v1/warehouse/inventory", { port_id: port.id }), 30_000, [port.id]);
  const [tons, setTons] = useState<number | null>(null);
  const act = useAction<S.PortWarehouseResult>(() => {
    setTons(null);
    void reload();
    onChange();
  });
  const leased = wh?.leased_tonnage ?? 0;
  const target = tons ?? leased;
  const capLeft = port.total_warehouse_cap - port.total_leased_warehouse + leased;

  return (
    <Panel title="Warehouse">
      <div className="space-y-3 text-sm">
        {!wh && !error ? (
          <Loading />
        ) : (
          <KV
            rows={[
              ["Leased", fmtTons(leased)],
              ["Used / reserved / free", wh ? `${fmtTons(wh.used_tonnage)} / ${fmtTons(wh.reserved_tonnage)} / ${fmtTons(wh.free_tonnage)}` : "—"],
              ["Counting house from", fmtTons(port.counting_house_min_lease_tons)],
              ["Port space left", fmtTons(Math.max(0, capLeft))],
            ]}
          />
        )}
        {wh && wh.inventory.length > 0 && (
          <Table head={["Good", "Tons", "Locked"]}>
            {wh.inventory.map((i) => (
              <tr key={i.commodity_id}>
                <td>{goodName(i.commodity_id)}</td>
                <td className="tabular-nums">{i.quantity}</td>
                <td className="text-muted-foreground tabular-nums">{i.locked_quantity || "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex items-end gap-2">
          <Field label="Lease (t)" className="flex-1">
            <Input type="number" min={0} value={target} onChange={(e) => setTons(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </Field>
          <Button size="sm" disabled={act.busy || target === leased}
            onClick={() => void act.run(() => kibbPost<S.PortWarehouseResult>("/v1/warehouse/set-lease", { port_id: port.id, target_leased_tonnage: target }))}>
            Set lease
          </Button>
        </div>
        {leased < port.counting_house_min_lease_tons && (
          <Button size="sm" variant="outline" disabled={act.busy}
            onClick={() => void act.run(() => kibbPost<S.PortWarehouseResult>("/v1/warehouse/set-lease", { port_id: port.id, target_leased_tonnage: port.counting_house_min_lease_tons }))}>
            Lease {fmtTons(port.counting_house_min_lease_tons)} for live prices
          </Button>
        )}
        <ErrorNote error={act.error} />
        <p className="text-muted-foreground text-xs">
          Needs presence (a ship in port or a factor). Rent is billed daily from this region&apos;s vault, dearer when the port is congested;
          unused leased tons cost triple when the port is over 70% leased. Any lease shows a daily price snapshot; the counting-house size shows live prices.
        </p>
      </div>
    </Panel>
  );
}

export function PortEventsPanel({ portId }: { portId: string }) {
  const { goodName } = useCatalog();
  const [expired, setExpired] = useState(false);
  const { data: events, error } = usePoll(
    () => kibbGet<S.WorldEventResult[]>("/v1/world/events", { port_id: portId, include_expired: expired, limit: 50 }),
    120_000,
    [portId, expired],
  );
  return (
    <Panel
      title="Port events"
      action={
        <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <input type="checkbox" checked={expired} onChange={(e) => setExpired(e.target.checked)} />
          include past
        </label>
      }
    >
      <ErrorNote error={error} />
      {!events ? (
        <Loading />
      ) : events.length === 0 ? (
        <Empty>No {expired ? "" : "active "}events here.</Empty>
      ) : (
        <Table head={["Event", "Good", "Started", "Ends", ""]}>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <div className="font-medium">{e.title}</div>
                <div className="text-muted-foreground text-xs">{e.description}</div>
              </td>
              <td className="text-xs">{e.commodity_id ? goodName(e.commodity_id) : "—"}</td>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(e.starts_at)}</td>
              <td className="whitespace-nowrap text-xs">{e.is_active ? fmtIn(e.expires_at) : fmtDateTime(e.expires_at)}</td>
              <td>
                <span className="inline-flex gap-1">
                  <Badge variant="outline" size="sm">{e.event_type.replace(/_/g, " ")}</Badge>
                  {e.structural && <Badge variant="warning" size="sm">lasting</Badge>}
                </span>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}
