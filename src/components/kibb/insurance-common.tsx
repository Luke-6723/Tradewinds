"use client";

// Insurance pieces shared by the insurance page and the ship page: quoting a voyage with Lloyd's first,
// requesting a policy (keeping the insurable cap from a refusal), and Lloyd's posted prices on a lane.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote, KV } from "@/components/kibb/bits";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, dash, kibbGet, writeFetch } from "@/lib/kibb/browser";
import { fmtBps, fmtCr } from "@/lib/kibb/format";
import type * as S from "@/lib/kibb/schema";

export interface InsurableValue {
  requested_pence: number;
  max_insurable_pence: number;
  hull_value_pence: number;
}

/**
 * POST through the proxy keeping the whole problem body: an `exceeds_insurable_value` answer
 * carries the cap, which the usual helper drops. The error then states it in Crowns.
 */
export async function createPolicy(body: S.CreateInsurancePolicyRequest): Promise<S.CreateInsurancePolicyResult> {
  // One key per request: a retry after a timeout or 5xx replays it rather than listing a second policy.
  const res = await writeFetch("POST", "/api/kibb/v1/insurance/create", JSON.stringify(body));
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return data as S.CreateInsurancePolicyResult;
  const p = (data && typeof data === "object" ? data : {}) as { code?: string; detail?: string; title?: string; insurable_value?: InsurableValue };
  if (res.status === 401 && p.code === "not_signed_in") window.location.href = "/login";
  else if (res.status === 401 && (p.code === "no_company_key" || p.code === "no_company")) window.location.href = "/companies";
  const cap = p.insurable_value;
  const detail = cap
    ? `${fmtCr(cap.requested_pence, 2)} is more than this ship can be insured for: at most ${fmtCr(cap.max_insurable_pence, 2)} (hull ${fmtCr(cap.hull_value_pence, 2)} + cargo ${fmtCr(cap.max_insurable_pence - cap.hull_value_pence, 2)}).`
    : (p.detail ?? p.title ?? (typeof data === "string" && data ? data : res.statusText));
  throw Object.assign(new DashboardApiError(res.status, p.code, detail), { insurableValue: cap });
}

/** The cap carried by a `createPolicy` refusal, if any. */
export const capFrom = (e: unknown): InsurableValue | null => (e as { insurableValue?: InsurableValue } | null)?.insurableValue ?? null;

/** The cap from a refusal, with a button that fills the sum insured (in Crowns) with it. */
export function InsurableCap({ cap, valueCr, onUseMax }: { cap: InsurableValue; valueCr: string; onUseMax: (cr: string) => void }) {
  const maxCr = String(cap.max_insurable_pence / 100);
  return (
    <div className="space-y-2">
      <KV
        rows={[
          ["Hull (rebuild quote + guns)", fmtCr(cap.hull_value_pence, 2)],
          ["Cargo aboard", fmtCr(cap.max_insurable_pence - cap.hull_value_pence, 2)],
          ["Most insurable", fmtCr(cap.max_insurable_pence, 2)],
        ]}
      />
      {valueCr !== maxCr && (
        <Button size="sm" variant="outline" onClick={() => onUseMax(maxCr)}>
          Use the max ({fmtCr(cap.max_insurable_pence, 2)})
        </Button>
      )}
    </div>
  );
}

/** Hull-only cover: nothing declared above the hull value, so it pays only on a sinking. */
export const isHullOnly = (p: { insured_value_pence: number; hull_value_pence: number }) => p.insured_value_pence <= p.hull_value_pence;

/**
 * Lloyd's writes only if premium ≥ ceil(1.25 × expected loss) + 25 bps, or expected loss + 25 when the hull is rated for
 * the water of every leg (guide 3.6), so a premium it accepted bounds the expected loss (bps). Which rule applied isn't on
 * the listing, so the smaller multiplier, 1, gives the bound that holds either way. Only where a listing doesn't carry
 * Lloyd's own estimate (`lloyds_expected_loss_bps`).
 */
export const impliedMaxEl = (premiumBps: number) => Math.max(0, (premiumBps - 25) / 1);

/**
 * A partial loss's share of the declared cargo, for the worst-hit figure: pirates who let the ship go claim what they
 * seized, at most half. A storm claims the share it took, which varies (most are light, a heavy one takes much more), so
 * this is a guide for a bad storm, not a cap on one.
 */
export const MAX_PARTIAL_SHARE = 0.5;

/** The most a slice of a policy covered `coveredBps` may be: steps of 100 from 500, or a remainder under 500 whole (guide 3.6). */
export function maxSliceFor(coveredBps: number): number {
  const uncovered = Math.max(0, 10_000 - coveredBps);
  return uncovered < 500 ? uncovered : Math.floor(uncovered / 100) * 100;
}

/** Whether `slice` bps may be written on a policy with `uncovered` bps left. */
export function sliceOk(slice: number, uncovered: number): boolean {
  if (uncovered <= 0 || slice <= 0) return false;
  return uncovered < 500 ? slice === uncovered : slice >= 500 && slice <= uncovered && slice % 100 === 0;
}

/** Lloyd's price for a voyage, as `insurance/quote` gives it for this ship, port and sum insured; null until asked, undefined while loading. */
export function useInsuranceQuote(shipId: string, dest: string, valuePence: number) {
  const ok = !!shipId && !!dest && Number.isFinite(valuePence) && valuePence > 0;
  return usePoll(
    ok ? () => kibbGet<S.LloydsQuoteResult>("/v1/insurance/quote", { ship_id: shipId, dest_port_id: dest, insured_value_pence: Math.round(valuePence) }) : null,
    30_000,
    [shipId, dest, ok ? Math.round(valuePence) : 0],
  );
}

/**
 * Lloyd's price for the voyage (quoted before a policy is asked for): the cap, its estimate of the claim and its
 * posted price, with buttons that declare the whole cargo and offer that price.
 */
export function QuoteGuide({
  quote,
  error,
  valueCr,
  premiumBps,
  onValue,
  onPremium,
}: {
  quote: S.LloydsQuoteResult | undefined;
  error: Error | null;
  valueCr: string;
  premiumBps: number;
  onValue: (cr: string) => void;
  onPremium: (bps: string) => void;
}) {
  if (error) return <ErrorNote error={`Lloyd's couldn't quote this voyage: ${error.message}`} />;
  if (!quote) return <p className="text-muted-foreground text-xs">Enter the port and sum insured for Lloyd&apos;s quote.</p>;
  const maxCr = String(quote.max_insurable_pence / 100);
  const short = quote.insured_value_pence < quote.max_insurable_pence;
  const entered = Number.isFinite(premiumBps);
  return (
    <div className="space-y-2">
      <KV
        rows={[
          ["Hull (rebuild quote + guns)", fmtCr(quote.hull_value_pence, 2)],
          ["Most insurable (hull + all cargo aboard)", fmtCr(quote.max_insurable_pence, 2)],
          ["Lloyd's expected claim (upper bound)", `${fmtBps(quote.lloyds_expected_loss_bps)} · ${fmtCr(quote.lloyds_expected_loss_pence)}`],
          ["Lloyd's price", quote.lloyds_writes ? `${fmtBps(quote.lloyds_premium_bps)} · ${fmtCr(quote.lloyds_premium_pence)}` : "won't write it (over 3,000 bps)"],
          ...(quote.priced_consort_ship_ids.length
            ? ([["Priced with consorts", `${quote.priced_consort_ship_ids.length} convoy ship(s): they must sail with her`]] as Array<[string, string]>)
            : []),
        ]}
      />
      <div className="flex flex-wrap gap-2">
        {valueCr !== maxCr && (
          <Button size="sm" variant="outline" onClick={() => onValue(maxCr)}>
            Declare everything ({fmtCr(quote.max_insurable_pence, 2)})
          </Button>
        )}
        {quote.lloyds_writes && premiumBps !== quote.lloyds_premium_bps && (
          <Button size="sm" variant="outline" onClick={() => onPremium(String(quote.lloyds_premium_bps))}>
            Offer Lloyd&apos;s price ({fmtBps(quote.lloyds_premium_bps)})
          </Button>
        )}
      </div>
      {short && (
        <p className="text-warning-foreground text-xs">
          Declare the whole cargo: cover under what is aboard is void if the hold draws more pirates than the declared cargo would
          (cargo_exceeds_declared). Load nothing after the policy is written.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {entered && quote.lloyds_writes
          ? premiumBps >= quote.lloyds_premium_bps
            ? `At or above Lloyd's price: it covers what players leave once the policy is an hour old (within its caps)${premiumBps > quote.lloyds_premium_bps ? ", and nothing above the price is refunded" : ""}.`
            : "Below Lloyd's price: only player underwriters may write it (they get the first hour); what they leave stays uncovered."
          : "Offer less than Lloyd's price to attract player underwriters in the hour before Lloyd's looks, or the price to be sure of cover."}{" "}
        The price moves with zone piracy, the season and your convoy: quote again just before asking.
      </p>
    </div>
  );
}

/** What the game said of a policy just written: Lloyd's price for it, and whether the offer is above it. */
export function createdText(p: S.CreateInsurancePolicyResult): string {
  if (p.lloyds_premium_bps == null) return "Lloyd's won't write this voyage (or couldn't rate it): only player underwriters may.";
  return p.above_lloyds_price
    ? `Above Lloyd's price of ${fmtBps(p.lloyds_premium_bps)}: charged in full, Lloyd's covers what players leave.`
    : p.premium_bps >= p.lloyds_premium_bps
      ? `At Lloyd's price of ${fmtBps(p.lloyds_premium_bps)}: Lloyd's covers what players leave.`
      : `Below Lloyd's price of ${fmtBps(p.lloyds_premium_bps)}: only player underwriters may write it.`;
}

const OWN_TTL = 120_000;
let ownCover: { at: number; ids: Promise<Set<string>> } | null = null;

/**
 * Every policy any of the player's companies holds a slice of. That cover is ours, not Lloyd's, so
 * it says nothing about what Lloyd's accepts (and counting it would let our own writes lower the bar).
 */
export function loadOwnCover(): Promise<Set<string>> {
  if (!ownCover || Date.now() - ownCover.at > OWN_TTL) {
    const ids = (async () => {
      const { companies } = await dash.get<{ companies: Array<{ id: string }> }>("/api/kibb/companies");
      const lists = await Promise.all(
        companies.map((c) => kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { underwriter_company_id: c.id, limit: 200 })),
      );
      return new Set(lists.flat().map((p) => p.id));
    })();
    const entry = { at: Date.now(), ids };
    ownCover = entry;
    ids.catch(() => {
      if (ownCover === entry) ownCover = null;
    });
  }
  return ownCover.ids;
}

/** `loadOwnCover`, re-read every couple of minutes; undefined until it loads. */
export function useOwnCover(): Set<string> | undefined {
  return usePoll(loadOwnCover, OWN_TTL).data;
}

/**
 * Lloyd's posted price (bps) on the lane's open policies (`lloyds_min_premium_bps`: other ships, guns and convoys), the
 * lowest by cover type; null where no listing carries one.
 */
export interface LaneFloors {
  hull: number | null;
  cargo: number | null;
}

export const laneKey = (origin: string, dest: string) => `${origin}>${dest}`;

export const floorFor = (f: LaneFloors | null | undefined, hullOnly: boolean) => (f ? (hullOnly ? f.hull : f.cargo) : null);

const LANE_TTL = 120_000;
const LANE_RETRY = 30_000;
// Shared across components so the market table, the policy panel and the forms read a lane once.
const laneCache = new Map<string, { at: number; floors: LaneFloors | null }>();
const laneInFlight = new Map<string, Promise<void>>();

async function loadLane(key: string): Promise<void> {
  const [origin, dest] = key.split(">");
  try {
    // Lloyd's own posted price on each listing still open for underwriting (no inference from who covered what).
    const rows = await kibbGet<S.InsurancePolicyListing[]>("/v1/insurance/list", { origin_port_id: origin, dest_port_id: dest, limit: 200 });
    const floors: LaneFloors = { hull: null, cargo: null };
    for (const p of rows) {
      if (typeof p.lloyds_min_premium_bps !== "number") continue;
      const k = isHullOnly(p) ? "hull" : "cargo";
      floors[k] = Math.min(floors[k] ?? Number.POSITIVE_INFINITY, p.lloyds_min_premium_bps);
    }
    laneCache.set(key, { at: Date.now(), floors });
  } catch {
    // Keep what was known; only the retry comes sooner.
    laneCache.set(key, { at: Date.now() - LANE_TTL + LANE_RETRY, floors: laneCache.get(key)?.floors ?? null });
  }
}

/**
 * Lane floors for each `[origin, dest]`, keyed by `laneKey`: `null` when the lookup failed,
 * missing while it loads. Each lane is re-read every couple of minutes.
 */
export function useLaneFloors(lanes: Array<[string, string]>): Map<string, LaneFloors | null> {
  const keys = [...new Set(lanes.filter(([o, d]) => o && d && o !== d).map(([o, d]) => laneKey(o, d)))].sort();
  const sig = keys.join(",");
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!sig) return;
    let alive = true;
    const refresh = () => {
      for (const k of sig.split(",")) {
        const c = laneCache.get(k);
        if (c && Date.now() - c.at < LANE_TTL) continue;
        let job = laneInFlight.get(k);
        if (!job) {
          job = loadLane(k).finally(() => laneInFlight.delete(k));
          laneInFlight.set(k, job);
        }
        void job.then(() => alive && setTick((t) => t + 1));
      }
    };
    refresh();
    const timer = setInterval(refresh, LANE_RETRY);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sig]);

  const out = new Map<string, LaneFloors | null>();
  for (const k of keys) {
    const c = laneCache.get(k);
    if (c) out.set(k, c.floors);
  }
  return out;
}

const bpsText = (n: number) => `${n.toLocaleString("en-GB")} bps`;

/**
 * Lloyd's posted prices on this lane's open policies, beside the quote for this very voyage. `hullOnly` null means
 * the cover type isn't known yet (no cap seen and cargo aboard): both figures show.
 */
export function LaneGuide({
  floors,
  hullOnly,
  premiumBps,
}: {
  floors: LaneFloors | null | undefined;
  hullOnly: boolean | null;
  premiumBps: number;
}) {
  if (floors === undefined) return <p className="text-muted-foreground text-xs">Checking Lloyd&apos;s prices on this lane…</p>;
  if (floors === null) return <p className="text-muted-foreground text-xs">Couldn&apos;t read the open policies on this lane.</p>;
  const typed = hullOnly === null ? null : floorFor(floors, hullOnly);
  const known = [floors.hull, floors.cargo].filter((n): n is number => n !== null);
  const entered = Number.isFinite(premiumBps);

  let line: string;
  if (hullOnly !== null) {
    line =
      typed === null
        ? `No open ${hullOnly ? "hull-only" : "with-cargo"} policy on this lane right now.`
        : `Lloyd's posted price on this lane's open ${hullOnly ? "hull-only" : "with-cargo"} policies: from ${bpsText(typed)}.`;
  } else if (known.length === 0) {
    line = "No open policy on this lane right now.";
  } else {
    line = `Lloyd's posted price on this lane's open policies: from ${floors.hull === null ? "—" : bpsText(floors.hull)} hull only, ${floors.cargo === null ? "—" : bpsText(floors.cargo)} with cargo.`;
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {line} Those are other ships (guns, cargo, convoys): the quote above is this voyage&apos;s. A policy nobody writes can&apos;t be
        withdrawn: it blocks a new one until the ship sails or it lapses.
      </p>
      {entered && typed !== null && premiumBps < typed && (
        <p className="text-muted-foreground text-xs">{bpsText(premiumBps)} is below Lloyd&apos;s price on this lane&apos;s other policies of this cover.</p>
      )}
    </div>
  );
}
