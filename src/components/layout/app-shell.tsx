"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * Sidebar beside the page on large screens; below `lg` it becomes a drawer opened from the
 * header's menu button and closed by navigating, the backdrop or Escape.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {navOpen && <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" aria-hidden onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
