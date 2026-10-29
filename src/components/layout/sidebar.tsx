"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeftRightIcon,
  LogOutIcon,
  XIcon,
  BarChart3Icon,
  BellRingIcon,
  BriefcaseIcon,
  Building2Icon,
  CandlestickChartIcon,
  CrownIcon,
  Globe2Icon,
  HandCoinsIcon,
  HandshakeIcon,
  KeyRoundIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  MailIcon,
  MapIcon,
  MessagesSquareIcon,
  MoonIcon,
  PieChartIcon,
  PiggyBankIcon,
  SailboatIcon,
  ScaleIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  ShipIcon,
  ShipWheelIcon,
  SkullIcon,
  StoreIcon,
  SwordsIcon,
  TrophyIcon,
  UsersIcon,
  WarehouseIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePoll } from "@/hooks/use-poll";
import { dash, kibbGet } from "@/lib/kibb/browser";
import type { WorldClock } from "@/lib/kibb/types";

const nav = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboardIcon },
      { href: "/map", label: "Map", icon: Globe2Icon },
      { href: "/events", label: "Events", icon: BellRingIcon },
    ],
  },
  {
    group: "Trade",
    items: [
      { href: "/fleet", label: "Fleet", icon: ShipIcon },
      { href: "/ships-market", label: "Ship market", icon: StoreIcon },
      { href: "/convoys", label: "Convoys", icon: ShipWheelIcon },
      { href: "/market", label: "Market", icon: BarChart3Icon },
      { href: "/monopolies", label: "Monopolies", icon: CrownIcon },
      { href: "/contracts", label: "Contracts", icon: ScrollTextIcon },
      { href: "/passengers", label: "Passengers", icon: UsersIcon },
      { href: "/warehouses", label: "Warehouses", icon: WarehouseIcon },
      { href: "/underworld", label: "Underworld", icon: MoonIcon },
    ],
  },
  {
    group: "Finance",
    items: [
      { href: "/treasury", label: "Treasury", icon: LandmarkIcon },
      { href: "/loans", label: "Loans", icon: HandCoinsIcon },
      { href: "/banks", label: "Banks", icon: PiggyBankIcon },
      { href: "/ventures", label: "Ventures", icon: HandshakeIcon },
      { href: "/shares", label: "Ship shares", icon: PieChartIcon },
      { href: "/insurance", label: "Insurance", icon: ShieldCheckIcon },
      { href: "/futures", label: "Futures", icon: CandlestickChartIcon },
    ],
  },
  {
    group: "World",
    items: [
      { href: "/ports", label: "Ports", icon: MapIcon },
      { href: "/zones", label: "Sea zones", icon: SkullIcon },
      { href: "/rivals", label: "Rivals", icon: SwordsIcon },
      { href: "/envelopes", label: "Envelopes", icon: MailIcon },
      { href: "/exchange", label: "Exchange", icon: ScaleIcon },
      { href: "/desks", label: "NPC desks", icon: BriefcaseIcon },
      { href: "/bulletin", label: "Bulletin", icon: MessagesSquareIcon },
      { href: "/leaderboard", label: "Leaderboard", icon: TrophyIcon },
    ],
  },
  {
    group: "Company",
    items: [
      { href: "/company", label: "Company", icon: Building2Icon },
      { href: "/account", label: "Account", icon: KeyRoundIcon },
    ],
  },
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

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await dash.post("/api/kibb/auth/logout").catch(() => undefined);
    router.push("/login");
  }

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 lg:static lg:w-56 lg:shrink-0 lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <SailboatIcon className="mr-2 size-5 text-primary" />
        <span className="font-bold text-lg tracking-tight">Tradewinds</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
          aria-label="Close menu"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {nav.map(({ group, items }) => (
          <div key={group} className="pb-2">
            <div className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-wider">{group}</div>
            {items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 font-medium text-sm transition-colors lg:py-1.5",
                  pathname === href || pathname.startsWith(`${href}/`)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t p-4">
        <WorldClockPanel />
        {/* The header has no room for these on small screens. */}
        <div className="flex gap-2 md:hidden">
          <Link
            href="/companies"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftRightIcon className="size-3.5" />
            Switch company
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
          >
            <LogOutIcon className="size-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
