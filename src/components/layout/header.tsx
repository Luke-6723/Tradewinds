"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BellRingIcon, BotIcon, MenuIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { usePoll } from "@/hooks/use-poll";
import { useCatalog } from "@/hooks/use-catalog";
import { dash, kibbGet } from "@/lib/kibb/browser";
import { fmtCr } from "@/lib/kibb/format";
import type { FleetView } from "@/lib/kibb/fleet-registry";
import type { CompanyProfile } from "@/lib/kibb/types";

export function Header({ onMenu }: { onMenu: () => void }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { portName } = useCatalog();
  const { data: profile, loading } = usePoll(() => kibbGet<CompanyProfile>("/v1/company/profile"), 15_000, [pathname]);
  const { data: runner } = usePoll(() => dash.get<FleetView>("/api/kibb/fleet"), 10_000, [pathname]);
  const { data: health, error: healthError } = usePoll(
    () => dash.get<{ healthz: string; readyz: string; ok: boolean }>("/api/kibb/health"),
    60_000,
  );
  const apiUp = health?.ok === true && !healthError;

  const cash = profile?.vaults.filter((v) => v.account_type === "vault").reduce((n, v) => n + v.balance_pence, 0);
  const status = runner?.state?.status;

  async function handleSignOut() {
    await dash.post("/api/kibb/auth/logout").catch(() => undefined);
    router.push("/login");
  }

  const autopilotOn = status === "running" || status === "starting";
  // The company key running out stops the autopilot: flagged in its last 3 days. A stopped manager's reading may
  // predate a renewal: the stored key's then.
  const keyExpiresAt = (autopilotOn ? runner?.state?.keyExpiresAt : null) ?? runner?.keyExpiresAt ?? null;
  const keyDays = keyExpiresAt ? (Date.parse(keyExpiresAt) - Date.now()) / 86_400_000 : null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 sm:gap-3 sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        className="-ml-1 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
        aria-label="Open menu"
      >
        <MenuIcon className="size-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        {loading && !profile ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : profile ? (
          <>
            <span className="truncate font-semibold">{profile.company.name}</span>
            <Badge variant="secondary" size="sm" className="hidden sm:inline-flex">{portName(profile.company.home_port_id)}</Badge>
            <span className="hidden text-muted-foreground text-xs md:inline">{profile.handle}</span>
          </>
        ) : (
          <span className="truncate text-muted-foreground text-sm">No company selected</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {(health || healthError) && (
          <span
            className="flex items-center gap-1.5 text-muted-foreground text-xs"
            title={healthError ? `Dashboard can't reach the game: ${healthError.message}` : `Game API: health ${health?.healthz}, ready ${health?.readyz}`}
          >
            <span className={`size-2 rounded-full ${apiUp ? "bg-success" : "bg-destructive"}`} />
            <span className={apiUp ? "hidden sm:inline" : undefined}>{apiUp ? "API" : "API down"}</span>
          </span>
        )}
        <Link href="/events" className="text-muted-foreground transition-colors hover:text-foreground" title="Events and server announcements">
          <BellRingIcon className="size-4" />
        </Link>
        {runner && (
          <Badge variant={autopilotOn ? "success" : status === "failed" ? "error" : "secondary"} className="gap-1.5" title="Fleet autopilot">
            <BotIcon className="size-3" />
            <span className="hidden sm:inline">Autopilot</span> {autopilotOn ? "on" : status === "failed" ? "failed" : "off"}
          </Badge>
        )}
        {autopilotOn && runner?.state?.paused && (
          <Badge variant="warning" title="The operators paused the world: ships wait until it resumes">
            World paused
          </Badge>
        )}
        {runner?.state?.announcement && (
          <Link href="/events" title={`Critical notice from the operators: ${runner.state.announcement.message}`}>
            <Badge variant="error">Server notice</Badge>
          </Link>
        )}
        {keyDays !== null && keyDays < 3 && (
          <Link href="/companies" title={`The company key expires ${keyExpiresAt}: sign in again and select the company to renew it`}>
            <Badge variant="warning">key {keyDays <= 0 ? "expired" : keyDays >= 1 ? `${Math.floor(keyDays)}d` : `${Math.max(1, Math.floor(keyDays * 24))}h`}</Badge>
          </Link>
        )}
        {cash !== undefined && <span className="font-mono text-muted-foreground text-xs sm:text-sm">{fmtCr(cash)}</span>}
        <button
          type="button"
          onClick={() => router.push("/companies")}
          className="hidden text-muted-foreground text-xs transition-colors hover:text-foreground md:inline"
          title="Switch company"
        >
          Switch
        </button>
        <Button variant="ghost" size="sm" onClick={handleSignOut} className="hidden text-xs md:inline-flex">
          Sign out
        </Button>
      </div>
    </header>
  );
}
