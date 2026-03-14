"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AnchorIcon,
  BarChart3Icon,
  ClipboardListIcon,
  Globe2Icon,
  LayoutDashboardIcon,
  MapIcon,
  PackageIcon,
  ShipIcon,
  ShoppingCartIcon,
  StoreIcon,
  TableIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EventsFeed } from "@/components/layout/events-feed";

const nav = [
  { href: "/dashboard",    label: "Dashboard",    icon: LayoutDashboardIcon },
  { href: "/map",          label: "Map",           icon: Globe2Icon },
  { href: "/ports",        label: "Ports",         icon: MapIcon },
  { href: "/trade",        label: "Trade",         icon: StoreIcon },
  { href: "/quotes",       label: "Quotes",        icon: ClipboardListIcon },
  { href: "/quote-board",  label: "Quote Board",   icon: TableIcon },
  { href: "/market",       label: "Market",        icon: BarChart3Icon },
  { href: "/fleet",        label: "Fleet",         icon: ShipIcon },
  { href: "/warehouses",   label: "Warehouses",    icon: AnchorIcon },
  { href: "/goods",        label: "Goods",         icon: PackageIcon },
  { href: "/passengers",   label: "Passengers",    icon: UsersIcon },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <ShoppingCartIcon className="mr-2 size-5 text-primary" />
        <span className="font-bold text-lg tracking-tight">Tradewinds</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
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
      <div className="flex flex-col gap-3 border-t p-3">
        <EventsFeed type="company" compact />
        <EventsFeed type="world" compact />
      </div>
    </aside>
  );
}
