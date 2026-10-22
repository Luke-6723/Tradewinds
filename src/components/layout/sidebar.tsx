"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3Icon, Globe2Icon, LayoutDashboardIcon, MapIcon, ShipIcon, SailboatIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePoll } from "@/hooks/use-poll";
import { kibbGet } from "@/lib/kibb/browser";
import type { WorldClock } from "@/lib/kibb/types";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/map",       label: "Map",       icon: Globe2Icon },
  { href: "/fleet",     label: "Fleet",     icon: ShipIcon },
  { href: "/market",    label: "Market",    icon: BarChart3Icon },
  { href: "/ports",     label: "Ports",     icon: MapIcon },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function WorldClockPanel() {
  const { data: clock } = usePoll(() => kibbGet<WorldClock>("/v1/world/clock"), 60_000);
  if (!clock) return null;
  const c = clock.calendar;
  const stormy = [11, 12, 1, 2].includes(c.month);
  return (
    <div className="space-y-0.5 text-muted-foreground text-xs">
      <div className="font-medium text-foreground">
        {c.day} {MONTHS[c.month - 1]} {c.year}, {String(c.hour).padStart(2, "0")}:{String(c.minute).padStart(2, "0")}
      </div>
      <div className="capitalize">
        {c.season}
        {stormy && " · storm season"} · {c.time_scale}× time
      </div>
      <div>
        Season {clock.season_number} · phase {clock.unlocked_phase} open
      </div>
      {clock.paused && <div className="text-warning-foreground">World paused</div>}
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <SailboatIcon className="mr-2 size-5 text-primary" />
        <span className="font-bold text-lg tracking-tight">Tradewinds</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 font-medium text-sm transition-colors",
              pathname === href || pathname.startsWith(`${href}/`)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="border-t p-4">
        <WorldClockPanel />
      </div>
    </aside>
  );
}
