"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorNote } from "@/components/kibb/bits";
import { useCatalog } from "@/hooks/use-catalog";
import { dash } from "@/lib/kibb/browser";
import type { Company, Player } from "@/lib/kibb/types";

type CompanyRow = Company & { has_key: boolean };

export default function CompaniesPage() {
  const router = useRouter();
  const { portName } = useCatalog();
  const [player,    setPlayer]    = useState<Player | null>(null);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [activeId,  setActiveId]  = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    dash
      .get<{ player: Player; companies: CompanyRow[]; active_company_id: string | null }>("/api/kibb/companies")
      .then((d) => {
        setPlayer(d.player);
        setCompanies(d.companies);
        setActiveId(d.active_company_id);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function select(company: CompanyRow) {
    setSelecting(company.id);
    setError(null);
    try {
      await dash.post("/api/kibb/companies/select", { company_id: company.id });
      // Hard navigation so every component picks up the new company cookie
      window.location.href = "/dashboard";
    } catch (e) {
      setError((e as Error).message);
      setSelecting(null);
    }
  }

  async function signOut() {
    await dash.post("/api/kibb/auth/logout").catch(() => undefined);
    router.push("/login");
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-lg">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-lg">Your companies</h2>
          {player && <p className="text-muted-foreground text-xs">Signed in as {player.handle}</p>}
        </div>
        {companies.length > 0 && companies.length < 5 && (
          <Button variant="outline" size="sm" render={<Link href="/companies/new" />}>
            + New
          </Button>
        )}
      </div>

      <ErrorNote error={error} className="mb-4" />

      {companies.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">No companies yet.</p>
          <Button className="mt-4" render={<Link href="/companies/new" />}>
            Found your first company
          </Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {companies.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => select(c)}
                disabled={!!selecting}
                className="w-full rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    {c.id === activeId && <Badge variant="secondary" size="sm">Active</Badge>}
                  </div>
                  {selecting === c.id ? <Spinner /> : <span className="text-muted-foreground text-xs">Enter →</span>}
                </div>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  Home port {portName(c.home_port_id)} · {c.crown_prestige.toLocaleString()} prestige
                  {!c.has_key && " · new key will be minted"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 border-t pt-4">
        <button type="button" onClick={signOut} className="text-muted-foreground text-xs hover:text-foreground">
          Sign out
        </button>
      </div>
    </div>
  );
}
