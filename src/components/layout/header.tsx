"use client";

import { usePathname, useRouter } from "next/navigation";
import { BotIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usePoll } from "@/hooks/use-poll";
import { useCatalog } from "@/hooks/use-catalog";
import { dash, kibbGet } from "@/lib/kibb/browser";
import { fmtCr } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { CompanyProfile } from "@/lib/kibb/types";

export function Header() {
  const router   = useRouter();
  const pathname = usePathname();
  const { portName } = useCatalog();
  const { data: profile, loading } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 15_000, [pathname]);
  const { data: runner } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 10_000, [pathname]);

  const cash = profile?.vaults.filter((v) => v.account_type === "vault").reduce((n, v) => n + v.balance_pence, 0);
  const status = runner?.state?.status;

  async function handleSignOut() {
    await dash.post("/api/kibb/auth/logout").catch(() => undefined);
    router.push("/login");
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-3">
        {loading && !profile ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : profile ? (
          <>
            <span className="font-semibold">{profile.company.name}</span>
            <Badge variant="secondary" size="sm">{portName(profile.company.home_port_id)}</Badge>
            <span className="text-muted-foreground text-xs">{profile.handle}</span>
          </>
        ) : (
          <span className="text-muted-foreground text-sm">No company selected</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {runner && (
          <Badge
            variant={status === "running" || status === "starting" ? "success" : status === "failed" ? "error" : "secondary"}
            className="gap-1.5"
          >
            <BotIcon className="size-3" />
            Autopilot {status === "running" || status === "starting" ? "on" : status === "failed" ? "failed" : "off"}
          </Badge>
        )}
        {cash !== undefined && <span className="font-mono text-muted-foreground text-sm">{fmtCr(cash)}</span>}
        <button
          type="button"
          onClick={() => router.push("/companies")}
          className="text-muted-foreground text-xs transition-colors hover:text-foreground"
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
