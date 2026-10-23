"use client";

// Pieces shared by the convoys, sea zones, insurance and futures pages.

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { CompanyProfile, WorldClock } from "@/lib/kibb/types";

export const PAGE_SIZE = 50;

/** The active company's id (for "ours" checks and list filters). */
export function useCompanyId(): string | undefined {
  const { data } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"));
  return data?.company.id;
}

/** Game time per real time (60 unless the world says otherwise). */
export function useTimeScale(): number {
  const { data } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 300_000);
  return data?.calendar.time_scale || 60;
}

/** A span of game minutes in real time at this game speed: "about 25 real min". */
export function realTime(gameMinutes: number, timeScale: number): string {
  const min = gameMinutes / timeScale;
  if (min < 1) return `about ${Math.max(1, Math.round(min * 60))} real s`;
  if (min < 120) return `about ${Math.round(min)} real min`;
  return `about ${(min / 60).toFixed(1)} real h`;
}

/** Ships the fleet autopilot is sailing right now. */
export function useAutopilotShips(): Set<string> {
  const { data } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 15_000);
  return new Set(data?.enabled ? (data.state?.agents ?? []).map((a) => a.shipId) : []);
}

export function AutopilotWarning({ show, children }: { show: boolean; children?: ReactNode }) {
  if (!show) return null;
  return (
    <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
      {children ?? "The fleet autopilot is sailing this ship and may move it at any moment. Stop it on the dashboard before giving manual orders."}
    </p>
  );
}

/** Cursor paging (`cursor` = last id of the previous page): a stack of cursors, one per page after the first. */
export function useCursor() {
  const [stack, setStack] = useState<string[]>([]);
  return {
    cursor: stack.at(-1),
    page: stack.length + 1,
    next: (lastId: string) => setStack((s) => [...s, lastId]),
    prev: () => setStack((s) => s.slice(0, -1)),
    reset: () => setStack([]),
  };
}

export function Pager({
  pager,
  rows,
}: {
  pager: ReturnType<typeof useCursor>;
  rows: Array<{ id: string }> | undefined;
}) {
  const hasNext = (rows?.length ?? 0) >= PAGE_SIZE;
  if (pager.page === 1 && !hasNext) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-muted-foreground text-xs">
      <span>Page {pager.page}</span>
      <Button size="sm" variant="outline" disabled={pager.page === 1} onClick={pager.prev}>
        Newer
      </Button>
      <Button size="sm" variant="outline" disabled={!hasNext} onClick={() => rows?.length && pager.next(rows[rows.length - 1].id)}>
        Older
      </Button>
    </div>
  );
}

/** Two-way segmented toggle, like the market's Buy/Sell switch. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 whitespace-nowrap rounded-md px-3 py-1 font-medium text-sm ${value === o.value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");

/** Number input value → number, empty → NaN. */
export const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
