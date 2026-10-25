"use client";

// Insurance pieces shared by the insurance page and the ship page: requesting a policy (keeping the
// insurable cap from a refusal), and what underwriters have accepted before on a lane.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorNote, KV } from "@/components/kibb/bits";
import { usePoll } from "@/hooks/use-poll";
import { DashboardApiError, dash, kibbGet, writeFetch } from "@/lib/kibb/browser";
import { fmtCr } from "@/lib/kibb/format";
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
export async function createPolicy(body: S.CreateInsurancePolicyRequest): Promise<S.InsurancePolicy> {
  // One key per request: a retry after a timeout or 5xx replays it rather than listing a second policy.
  const res = await writeFetch("POST", "/api/kibb/v1/insurance/create", JSON.stringify(body));
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return data as S.InsurancePolicy;
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

/** Lloyd's writes only if premium ≥ 1.25 × expected loss + 25 bps, so a premium it accepted bounds the expected loss (bps). */
export const impliedMaxEl = (premiumBps: number) => Math.max(0, (premiumBps - 25) / 1.25);

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

/** Lowest premium (bps) of a policy on the lane that got any cover, by cover type; null where none did. */
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
    const [rows, own] = await Promise.all([
      kibbGet<S.InsurancePolicy[]>("/v1/insurance/list", { origin_port_id: origin, dest_port_id: dest, limit: 200 }),
      loadOwnCover().catch(() => new Set<string>()),
    ]);
    const floors: LaneFloors = { hull: null, cargo: null };
    for (const p of rows) {
      if (p.covered_bps <= 0 || p.premium_bps <= 25 || own.has(p.id)) continue;
      const k = isHullOnly(p) ? "hull" : "cargo";
      floors[k] = Math.min(floors[k] ?? Number.POSITIVE_INFINITY, p.premium_bps);
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
 * What has been covered on this lane before, for a new policy's premium. `hullOnly` null means the
 * cover type isn't known yet (no cap seen and cargo aboard): both figures show.
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
  if (floors === undefined) return <p className="text-muted-foreground text-xs">Checking what has been covered on this lane…</p>;
  if (floors === null) return <p className="text-muted-foreground text-xs">Couldn&apos;t read past cover on this lane.</p>;
  const typed = hullOnly === null ? null : floorFor(floors, hullOnly);
  const known = [floors.hull, floors.cargo].filter((n): n is number => n !== null);
  const low = hullOnly === null ? (known.length ? Math.min(...known) : null) : typed;
  const entered = Number.isFinite(premiumBps);

  let line: string;
  if (hullOnly !== null) {
    line =
      typed === null
        ? `No ${hullOnly ? "hull-only" : "with-cargo"} policy on this lane has been covered yet: nothing to price against.`
        : `Policies on this lane have been covered at ≥ ${bpsText(typed)} (${hullOnly ? "hull only" : "with cargo"}).`;
  } else if (known.length === 0) {
    line = "No policy on this lane has been covered yet: nothing to price against.";
  } else {
    line = `Policies on this lane have been covered at ≥ ${floors.hull === null ? "—" : bpsText(floors.hull)} hull only, ≥ ${floors.cargo === null ? "—" : bpsText(floors.cargo)} with cargo.`;
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {line} That cover may be Lloyd&apos;s or another player&apos;s, on a better-armed ship or in a calmer season, so price above
        it. A policy nobody writes can&apos;t be withdrawn: it blocks a new one until the ship sails or it lapses.
      </p>
      {entered && low !== null && premiumBps < low && (
        <ErrorNote error={`${bpsText(premiumBps)} is below anything covered on this lane: Lloyd's will likely never write it.`} />
      )}
      {entered && hullOnly === null && low !== null && floors.cargo !== null && premiumBps >= low && premiumBps < floors.cargo && (
        <p className="text-warning-foreground text-xs">Below the with-cargo figure: enough only for hull-only cover.</p>
      )}
    </div>
  );
}
