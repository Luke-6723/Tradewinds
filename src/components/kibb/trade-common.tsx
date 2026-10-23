"use client";

// Pieces shared by the market, contracts and warehouse pages.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { ContractListing } from "@/lib/kibb/schema";

export const toPence = (cr: number) => Math.round(cr * 100);

/** Ids of the ships the fleet autopilot is sailing right now. */
export function useAutopilotShips(): Set<string> {
  const { data } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 15_000);
  return new Set(data?.enabled ? (data.state?.agents.map((a) => a.shipId) ?? []) : []);
}

export function AutopilotWarning({ shipName }: { shipName?: string }) {
  return (
    <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
      The fleet autopilot is sailing {shipName ?? "this ship"}. Stop it on the dashboard before giving manual orders.
    </p>
  );
}

/**
 * Every row of a cursor-paged list (`cursor` = last id), fetched page by page until a short one.
 * Stops after `maxPages` as a guard.
 */
export async function fetchAll<T extends { id: string }>(
  path: string,
  query: NonNullable<Parameters<typeof kibbGet>[1]>,
  pageSize = 200,
  maxPages = 50,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await kibbGet<T[]>(path, { ...query, cursor, limit: pageSize });
    all.push(...page);
    if (page.length < pageSize) break;
    cursor = page.at(-1)?.id;
  }
  return all;
}

export type SealedTons = ((shipId: string, good: string | null | undefined) => number) & { reload: () => Promise<void> };

/**
 * Tons of sealed freight each of our ships carries, by good: aboard, but not ours to deliver to a
 * charter, sell or unload. Returns a lookup `(shipId, good) => tons`; its `reload()` refetches at
 * once (call it after accepting or delivering freight).
 */
/** `deps` refetch it, e.g. with each ships poll, so sealed tons never lag the manifests they're taken from. */
export function useSealedTons(deps: unknown[] = []): SealedTons {
  const { data, reload } = usePoll(
    () => fetchAll<ContractListing>("/v1/contract/list", { contract_type: "freight", status: "active" }),
    30_000,
    deps,
  );
  const tons = (shipId: string, good: string | null | undefined) =>
    (data ?? []).filter((c) => c.carrier_ship_id === shipId && c.commodity_id === good).reduce((n, c) => n + c.remaining_quantity, 0);
  return Object.assign(tons, { reload });
}

/** An all-or-nothing batch was refused; `batchIndex` is the item that failed (nothing applied). */
export class BatchError extends Error {
  constructor(
    message: string,
    public batchIndex: number | null,
  ) {
    super(message);
    this.name = "BatchError";
  }
}

/**
 * POSTs a `*-batch` call through the proxy. Like kibbPost, but keeps the problem's `batch_index`
 * so the form can point at the row that failed.
 */
export async function postBatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/kibb${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.ok) return data as T;
  const p = (data && typeof data === "object" ? data : {}) as { code?: string; detail?: string; title?: string; batch_index?: number | null };
  if (res.status === 401) {
    if (p.code === "not_signed_in") window.location.href = "/login";
    else if (p.code === "no_company_key" || p.code === "no_company") window.location.href = "/companies";
  }
  const detail = p.detail ?? p.title ?? (typeof data === "string" && data ? data : res.statusText);
  const idx = typeof p.batch_index === "number" ? p.batch_index : null;
  throw new BatchError(idx !== null ? `Item ${idx + 1}: ${detail}` : detail, idx);
}

/**
 * A cursor-paged list (`cursor` = last id). Reloads from the start when `deps` change;
 * `more()` appends the next page.
 */
export function usePaged<T extends { id: string }>(load: (cursor?: string) => Promise<T[]>, pageSize: number, deps: unknown[]) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const page = await loadRef.current();
      if (gen !== generation.current) return;
      setItems(page);
      setDone(page.length < pageSize);
      setError(null);
    } catch (e) {
      if (gen === generation.current) setError(e as Error);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [pageSize]);

  const more = useCallback(async () => {
    const gen = generation.current;
    const last = items.at(-1)?.id;
    setLoading(true);
    try {
      const page = await loadRef.current(last);
      if (gen !== generation.current) return;
      setItems((prev) => [...prev, ...page.filter((x) => !prev.some((y) => y.id === x.id))]);
      setDone(page.length < pageSize);
      setError(null);
    } catch (e) {
      if (gen === generation.current) setError(e as Error);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [items, pageSize]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { items, error, loading, done, reload, more };
}

export function LoadMore({ done, loading, onMore }: { done: boolean; loading: boolean; onMore: () => void }) {
  if (done) return null;
  return (
    <div className="pt-3 text-center">
      <Button size="sm" variant="outline" disabled={loading} onClick={onMore}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}

/** Toggles `id` in a selection set (returns a new set). */
export function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
