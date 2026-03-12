"use client";

import { useSse } from "@/hooks/use-sse";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EventsFeedProps {
  type: "world" | "company";
  className?: string;
}

export function EventsFeed({ type, className }: EventsFeedProps) {
  const url = type === "world" ? "/api/events/world" : "/api/events/company";
  const { events, connected, error } = useSse<Record<string, unknown>>(url);

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
      </div>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border bg-muted/30 p-2">
        {events.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {connected ? "Waiting for events…" : "Connecting…"}
          </p>
        ) : (
          events.map((evt, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: events are ordered by arrival
              key={i}
              className="flex flex-col gap-0.5 rounded-md border bg-background p-2 text-xs"
            >
              <div className="flex items-center gap-1.5">
                {typeof evt.type === "string" && evt.type && (
                  <Badge variant="secondary" size="sm">
                    {String(evt.type)}
                  </Badge>
                )}
                {typeof evt.timestamp === "string" && evt.timestamp && (
                  <span className="text-muted-foreground">
                    {new Date(String(evt.timestamp)).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(evt.data ?? evt, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
