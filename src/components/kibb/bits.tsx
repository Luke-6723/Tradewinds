"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ShipStatus } from "@/lib/kibb/types";

/** Card with a small header row (title + optional action) and padded body. */
export function Panel({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
        {action}
      </div>
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </Card>
  );
}

export function StatTile({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>{label}</span>
        {icon}
      </div>
      <div className="mt-1.5 font-semibold text-xl tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-muted-foreground text-xs">{sub}</div>}
    </Card>
  );
}

export function Progress({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

const SHIP_STATUS: Record<ShipStatus, { label: string; variant: "success" | "info" | "warning" | "destructive" }> = {
  berthed: { label: "Berthed", variant: "success" },
  anchored_roadstead: { label: "Roadstead", variant: "warning" },
  sailing: { label: "Sailing", variant: "info" },
  sunk: { label: "Sunk", variant: "destructive" },
};

export function ShipStatusBadge({ status }: { status: ShipStatus }) {
  const s = SHIP_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function ErrorNote({ error, className }: { error: Error | string | null | undefined; className?: string }) {
  if (!error) return null;
  return (
    <p className={cn("rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm", className)}>
      {typeof error === "string" ? error : error.message}
    </p>
  );
}

export function Loading() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-muted-foreground text-sm">{children}</p>;
}

/** Native select styled like the Input primitive; simpler than the Base UI select for forms. */
export function NativeSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-8.5 w-full rounded-lg border border-input bg-background px-2.5 text-base shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 dark:bg-input/32 sm:h-7.5 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}

/** Two-column key/value list. */
export function KV({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Plain table with muted header row. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground text-xs">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-2 font-medium first:pl-0 last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:px-2 [&_td]:py-2 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_tr]:border-b [&_tr:last-child]:border-0">
          {children}
        </tbody>
      </table>
    </div>
  );
}
