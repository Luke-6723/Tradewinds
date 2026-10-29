"use client";

// Selects for the ids most forms need, named from the catalog. Each takes value/onChange as strings.

import type { ReactNode } from "react";
import { NativeSelect } from "@/components/kibb/bits";
import { Label } from "@/components/ui/label";
import { useCatalog } from "@/hooks/use-catalog";
import { fmtTons } from "@/lib/kibb/format";
import type { BankingRegion, ShipResult } from "@/lib/kibb/types";

export const REGIONS: BankingRegion[] = ["channel", "north_sea", "baltic", "iberia", "caribbean", "america", "indian_ocean", "east_indies"];

/** Label above a control. */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

interface Base {
  value: string;
  onChange: (v: string) => void;
  /** Text of an empty first option; omit to force a choice. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function PortSelect({ value, onChange, placeholder, disabled, className, filter, maxPhase }: Base & {
  filter?: (portId: string) => boolean;
  /** Only ports open at this phase (usually the clock's `unlocked_phase`). */
  maxPhase?: number;
}) {
  const { catalog } = useCatalog();
  const ports = (catalog?.ports ?? [])
    .filter((p) => (maxPhase === undefined || p.phase <= maxPhase) && (!filter || filter(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {ports.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * Goods by name. Contraband (guide 3.18: no market, warehouse, charter, freight, future or pledge takes it) is left out
 * unless `contraband` is "include" (the Underworld page: every good) or "only" (contraband alone).
 */
export function GoodSelect({ value, onChange, placeholder, disabled, className, only, contraband = "exclude" }: Base & { only?: string[]; contraband?: "exclude" | "include" | "only" }) {
  const { catalog } = useCatalog();
  const goods = (catalog?.commodities ?? [])
    .filter((c) => !only || only.includes(c.id))
    .filter((c) => (contraband === "include" ? true : (c.category === "contraband") === (contraband === "only")))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {goods.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </NativeSelect>
  );
}

export function ZoneSelect({ value, onChange, placeholder, disabled, className, maxPhase }: Base & { maxPhase?: number }) {
  const { catalog } = useCatalog();
  const zones = (catalog?.sea_zones ?? []).filter((z) => maxPhase === undefined || z.phase <= maxPhase).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {zones.map((z) => (
        <option key={z.id} value={z.id}>
          {z.name} ({z.zone_class})
        </option>
      ))}
    </NativeSelect>
  );
}

export function RegionSelect({ value, onChange, placeholder, disabled, className }: Base) {
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {REGIONS.map((r) => (
        <option key={r} value={r}>
          {r.replace("_", " ")}
        </option>
      ))}
    </NativeSelect>
  );
}

/** The company's ships, optionally narrowed (e.g. berthed at one port); shows free hold. */
export function ShipSelect({ value, onChange, placeholder, disabled, className, ships, filter }: Base & {
  ships: ShipResult[] | undefined;
  filter?: (r: ShipResult) => boolean;
}) {
  const { portName } = useCatalog();
  const list = (ships ?? []).filter((r) => r.ship.status !== "sunk" && (!filter || filter(r)));
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={className}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {list.map((r) => (
        <option key={r.ship.id} value={r.ship.id}>
          {r.ship.name} · {r.ship.status === "sailing" ? "at sea" : portName(r.ship.current_port_id)} ·{" "}
          {fmtTons(r.effective_hold_capacity_tons - r.cargo_used_tons)} free
        </option>
      ))}
    </NativeSelect>
  );
}
