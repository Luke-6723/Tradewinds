"use client";

import { useEffect, useMemo, useState } from "react";
import { useSse } from "@/hooks/use-sse";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EventsFeedProps {
  type: "world" | "company";
  className?: string;
  compact?: boolean;
}

export function EventsFeed({ type, className, compact }: EventsFeedProps) {
  const url = type === "world" ? "/api/events/world" : "/api/events/company";
  const { events: liveEvents, connected, error } = useSse<Record<string, unknown>>(url);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);

  // Load persisted history from MongoDB on mount
  useEffect(() => {
    fetch(`/api/db/events?type=${type}`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: Record<string, unknown>[]) => setHistory(data.reverse()))
      .catch(() => {});
  }, [type]);

  // Merge: live events (newest first) + history (as background)
  // De-duplicate by timestamp+type to avoid showing the same event twice
  const merged = useMemo(() => {
    const seen = new Set<string>();
    const result: Record<string, unknown>[] = [];
    for (const evt of [...liveEvents, ...history]) {
      const key = `${String(evt.type ?? "")}|${String(evt.timestamp ?? evt.receivedAt ?? "")}|${JSON.stringify(evt.data ?? evt).slice(0, 64)}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(evt);
      }
    }
    return result;
  }, [liveEvents, history]);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {type === "world" ? "World Events" : "Company Events"}
        </span>
        <span
          className={cn(
            "size-2 rounded-full",
            connected ? "bg-green-500" : error ? "bg-destructive" : "bg-muted",
          )}
        />
        {history.length > 0 && !connected && (
          <span className="text-xs text-muted-foreground">(from history)</span>
        )}
      </div>
      <div className={cn("flex flex-col gap-1 overflow-y-auto rounded-lg border bg-muted/30 p-2", compact ? "max-h-40" : "max-h-64")}>
        {merged.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {connected ? "Waiting for events…" : "Connecting…"}
          </p>
        ) : (
          merged.map((evt, i) => {
            const payload = (evt.data as Record<string, unknown> | undefined) ?? evt;
            const ts = String(evt.timestamp ?? evt.receivedAt ?? "");
            const evtType = String(payload.type ?? evt.type ?? "");
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: events are ordered by arrival
                key={i}
                className="flex flex-col gap-0.5 rounded-md border bg-background p-2 text-xs"
              >
                <div className="flex items-center gap-1.5">
                  {evtType && (
                    <Badge variant="secondary" size="sm">
                      {evtType}
                    </Badge>
                  )}
                  {ts && (
                    <span className="text-muted-foreground">
                      {new Date(ts).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
