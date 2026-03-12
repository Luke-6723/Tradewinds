"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { companyApi } from "@/lib/api/company";
import type { Company } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";

const POLL_MS = 8_000;

export function Header() {
  const router   = useRouter();
  const pathname = usePathname();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchCompany = () => {
    companyApi
      .getCompany()
      .then(setCompany)
      .catch(() => setCompany(null))
      .finally(() => setLoading(false));
  };

  // Refetch immediately on every route change (catches company switches)
  useEffect(() => {
    fetchCompany();
  }, [pathname]);

  // Also poll on a timer to keep balance live
  useEffect(() => {
    timerRef.current = setInterval(fetchCompany, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <header className="flex justify-between items-center bg-card px-6 border-b h-14 shrink-0">
      <div className="flex items-center gap-3">
        {loading ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : company ? (
          <>
            <span className="font-semibold">{company.name}</span>
            <Badge variant="secondary" size="sm" className="font-mono">{company.ticker}</Badge>
            {company.status === "bankrupt" && (
              <Badge variant="destructive" size="sm">Bankrupt</Badge>
            )}
          </>
        ) : (
          <span className="text-muted-foreground text-sm">No company selected</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {company && (
          <span className="font-mono text-muted-foreground text-sm transition-all">
            £{company.treasury?.toLocaleString()}
          </span>
        )}
        <button
          onClick={() => router.push("/companies")}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="Switch company"
        >
          Switch
        </button>
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="text-xs">
          Sign out
        </Button>
      </div>
    </header>
  );
}
