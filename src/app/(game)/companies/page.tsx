"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Company } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

export default function CompaniesPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me/companies")
      .then((r) => r.json())
      .then((d) => setCompanies(d.data ?? []))
      .catch(() => setError("Failed to load companies."))
      .finally(() => setLoading(false));
  }, []);

  async function select(company: Company) {
    setSelecting(company.id);
    try {
      await fetch("/api/auth/select-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: company.id }),
      });
      // Hard navigation ensures fresh React tree + new cookie is used immediately
      window.location.href = "/dashboard";
    } catch {
      setError("Failed to select company.");
      setSelecting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">⚓ Tradewinds</h1>
          <p className="mt-1 text-sm text-muted-foreground">Choose your company</p>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Your companies</h2>
            <Link href="/companies/new">
              <Button variant="outline" size="sm">+ New</Button>
            </Link>
          </div>

          {error && (
            <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {companies.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground text-sm">No companies yet.</p>
              <Link href="/companies/new">
                <Button className="mt-4">Create your first company</Button>
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {companies.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => select(c)}
                    disabled={!!selecting}
                    className="w-full rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-semibold">{c.name}</span>
                        <Badge variant="secondary" size="sm" className="ml-2">
                          {c.ticker}
                        </Badge>
                      </div>
                      {selecting === c.id ? (
                        <Spinner />
                      ) : (
                        <span className="text-xs text-muted-foreground">Enter →</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      £{(c.treasury / 100).toLocaleString()} treasury
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 border-t pt-4">
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                router.push("/login");
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
