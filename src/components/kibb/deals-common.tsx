"use client";

// Pieces shared by the ship market, commissions, envelopes, monopolies, contracts and ship pages
// (guide 3.4 ship market and commissions, 3.7 player charters, 3.9 monopolies, 3.11 envelopes).

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { DealsReport } from "@/lib/kibb/fleet/manager";
import type * as S from "@/lib/kibb/schema";
import type { CompanyProfile, ShipResult } from "@/lib/kibb/types";

// ── Rules ─────────────────────────────────────────────────────────────────────

/** Ships for sale and commissions are priced within 50%..=150% of the hull's rebuild value (guide 3.4). */
export const SHIP_PRICE_BAND = { min: 0.5, max: 1.5 } as const;

/** 150 Cr a gun: refits, and the guns' part of a ship's rebuild value. */
export const GUN_PENCE = 15_000;

/** Commissions: the builder's collateral is at most 25% of the price; deadline 6..=1440 game hours. */
export const COMMISSION = { collateralMaxShare: 0.25, deadlineMinH: 6, deadlineMaxH: 1_440, deadlineDefaultH: 72 } as const;

/** Envelopes: life 1..=240 game hours (default 72); at most 20 open per company. */
export const ENVELOPE = { lifeDefaultH: 72, lifeMaxH: 240, maxOpen: 20 } as const;

export const ENVELOPE_CATEGORIES: Array<{ id: S.EnvelopeCategory; label: string; hint: string }> = [
  { id: "port_reports", label: "Port reports", hint: "the coffee-house board there plus your own crews' reports, the port's own quay included" },
  { id: "charters", label: "Charters", hint: "the port's own non-public charters, live, and the news of others' that has reached it" },
  { id: "sailings", label: "Sailings", hint: "the port's sailing notices of the last 24 game hours" },
];

/** Royal monopolies: 5, 10 or 20 game days; provisions and silver bullion are never sold; at most 2 in force per player. */
export const MONOPOLY = { terms: [5, 10, 20] as const, never: ["provisions", "silver_bullion"] as readonly string[], perPlayer: 2 } as const;

/** Player charters: 2..=20 game days (default 10); reward ≤ 10× the good's base price a ton; 10 open at once; title ≤ 120 characters. */
export const CHARTER = { minDays: 2, maxDays: 20, defaultDays: 10, rewardMaxX: 10, maxOpen: 10, titleMax: 120 } as const;

/** Convoys sail 1 game hour..14 game days after they are organized or announced; at most 5 announced still forming. */
export const CONVOY = { musterMinMin: 60, musterMaxMin: 14 * 24 * 60, announcedMax: 5, escortFeeMaxPence: 100_000 } as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Berthed or in the roadstead: lying at a port. */
export const atPort = (r: ShipResult) => (r.ship.status === "berthed" || r.ship.status === "anchored_roadstead") && !!r.ship.current_port_id;

/** The allowed price range around a rebuild value (pence). */
export function bandOf(rebuildPence: number): { min: number; max: number } {
  return { min: Math.ceil(rebuildPence * SHIP_PRICE_BAND.min), max: Math.floor(rebuildPence * SHIP_PRICE_BAND.max) };
}

/** What a discount yard (guide 3.4: Lisbon, Boston, Havana) takes off a build, in words. */
export function yardDiscountText(d: S.YardDiscount): string {
  return `shipwright labour ${(d.labour_discount_bps / 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}% cheaper${d.turnkey_markup_waived ? ", no turnkey markup" : ""}`;
}

/** A "discount yard" badge where the port has one; nothing elsewhere. A hull built there keeps the full rebuild value. */
export function DiscountYardBadge({ discount, size = "sm" }: { discount: S.YardDiscount | null | undefined; size?: "sm" | "default" }) {
  if (!discount) return null;
  return (
    <Badge variant="success" size={size} title={`Discount yard: ${yardDiscountText(discount)}. A hull built here has the same rebuild value as any other.`}>
      discount yard
    </Badge>
  );
}

/** "84%": a price as a share of a rebuild value. */
export const pctOf = (price: number, of: number | null | undefined) => (of && of > 0 ? `${Math.round((price / of) * 100)}%` : "—");

/** "1d 6h" from real seconds. */
export function ageText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A contract's raw record (`metadata`), when it is an object. */
const metaOf = (c: { metadata?: unknown }) => (c.metadata && typeof c.metadata === "object" ? (c.metadata as Record<string, unknown>) : {});

/**
 * An Admiralty commission (guide 3.4): the Crown orders a navy hull, so there is no buyer. `admiralty` on the listing or its
 * raw record, or a commission with no issuer.
 */
export const isAdmiralty = (c: { contract_type?: string; issuer_company_id?: string | null; metadata?: unknown; admiralty?: boolean }) =>
  c.admiralty === true || metaOf(c).admiralty === true || (c.contract_type === "commission" && !c.issuer_company_id);

/** Return freight (guide 3.8): a Merchant Adventurers' lot for the trip home, paid by the Crown (`funded_by: crown`). */
export const isReturnFreight = (c: { contract_type?: string; funded_by?: string | null; metadata?: unknown }) =>
  c.contract_type === "freight" && (c.funded_by === "crown" || metaOf(c).funded_by === "crown");

export const ADMIRALTY_NOTE =
  "An Admiralty commission: the Crown orders a navy hull and pays a little over its rebuild value into your vault in the yard's region on delivery. There is no buyer: the hull joins the Royal Navy and patrols the yard's waters for a while. Taking it escrows a deposit (its collateral), forfeited to the Crown if the deadline passes undelivered. You, counting your own and linked companies, may hold only one taken at a time, and it can't be financed. Building from your own materials is usually what makes it pay.";

export const RETURN_FREIGHT_NOTE =
  "Return freight: a lot for the trip home, paid by the Crown at a fixed rate by distance and sized for a big hold. The cargo isn't real goods: it appears sealed in the hold, labelled as a cheap local export, and simply leaves on delivery. It is worth nothing (no insurance, prize or salvage value; storms and pirates leave it alone, though it goes down with the ship), but the usual collateral is forfeited on default. One owner with its linked companies may carry only a few lots at a time.";

/** "Admiralty" on a commission the Crown ordered, with the rules as a tooltip. */
export function AdmiraltyBadge() {
  return (
    <Badge variant="warning" size="sm" title={ADMIRALTY_NOTE}>
      Admiralty
    </Badge>
  );
}

/** "Return freight (Crown)" on a Crown-paid freight lot, with what that means as a tooltip. */
export function ReturnFreightBadge() {
  return (
    <Badge variant="info" size="sm" title={RETURN_FREIGHT_NOTE}>
      Return freight (Crown)
    </Badge>
  );
}

/** A small "autopilot" tag for things the fleet autopilot did itself. */
export function AutopilotTag({ children = "autopilot", title }: { children?: ReactNode; title?: string }) {
  return (
    <Badge variant="info" size="sm" title={title}>
      {children}
    </Badge>
  );
}

// ── Presence ──────────────────────────────────────────────────────────────────

export interface Presence {
  ships: ShipResult[] | undefined;
  profile: CompanyProfile | undefined;
  /** Quay tier: a ship of ours berthed or anchored there, or a Resident Factor. */
  quay: Set<string>;
  /** Storage tier or better: the above, or any warehouse lease. */
  any: Set<string>;
  /** Our ships, factors and leases have all been read. */
  known: boolean;
  reload: () => void;
}

/** Where we have presence (guide 3.1): quay tier for ship listings, commissions, envelopes posted; any tier for envelopes bought. */
export function usePresence(): Presence {
  const { data: ships, reload: reloadShips } = usePoll(() => kibbGet<ShipResult[]>("/v1/fleet/ships", { limit: 200 }), 30_000);
  const { data: profile, reload: reloadProfile } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 60_000);
  const { data: leases, reload: reloadLeases } = usePoll(() => kibbGet<S.PortWarehouseResult[]>("/v1/warehouse/list"), 60_000);
  const quay = new Set<string>([
    ...(ships ?? []).filter(atPort).map((r) => r.ship.current_port_id as string),
    ...(profile?.factor_ports ?? []),
  ]);
  const any = new Set<string>([...quay, ...(leases ?? []).filter((w) => w.leased_tonnage > 0 || w.has_factor).map((w) => w.port_id)]);
  return {
    ships,
    profile,
    quay,
    any,
    known: ships !== undefined && profile !== undefined && leases !== undefined,
    reload: () => {
      void reloadShips();
      void reloadProfile();
      void reloadLeases();
    },
  };
}

// ── The autopilot's deals ─────────────────────────────────────────────────────

export interface DealsView {
  /** The autopilot is enabled for this company. */
  running: boolean;
  /** Its last deals report (kept after it stops), or null. */
  deals: DealsReport | null;
  /** Ships it sails now. */
  ships: Set<string>;
  /** A commission the autopilot took as builder (until delivered or lost), or null. */
  ourCommission: (id: string) => DealsReport["ours"][number] | null;
  /** Its view of an open commission at one of our yards (our build cost, margin, verdict), or null. */
  commissionSeen: (id: string) => DealsReport["commissions"][number] | null;
  /** Its view of a ship for sale at one of our quays (what building one costs, verdict), or null. */
  listingSeen: (id: string) => DealsReport["listings"][number] | null;
  /** One of the autopilot's own envelopes still open. */
  ourEnvelope: (id: string) => boolean;
}

/** The fleet autopilot's ship deals and envelopes (guide 3.4, 3.11), from its state. */
export function useDeals(): DealsView {
  const { data } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 30_000);
  const deals = data?.state?.deals ?? null;
  const running = !!data?.enabled;
  return {
    running,
    deals,
    ships: new Set(running ? (data?.state?.agents ?? []).map((a) => a.shipId) : []),
    ourCommission: (id) => deals?.ours.find((c) => c.id === id) ?? null,
    commissionSeen: (id) => deals?.commissions.find((c) => c.id === id) ?? null,
    listingSeen: (id) => deals?.listings.find((l) => l.id === id) ?? null,
    ourEnvelope: (id) => !!deals?.openEnvelopes.some((e) => e.id === id),
  };
}
