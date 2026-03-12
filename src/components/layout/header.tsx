"use client";

import { useEffect, useState } from "react";
import { companyApi } from "@/lib/api/company";
import type { Company } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

export function Header() {
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    companyApi
      .getCompany()
      .then(setCompany)
      .catch(() => setCompany(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <header className="flex justify-between items-center bg-card px-6 border-b h-14 shrink-0">
      <div className="flex items-center gap-3">
        {loading ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : company ? (
          <>
            <span className="font-semibold">{company.name}</span>
            {company.is_locked && (
              <Badge variant="destructive" size="sm">Locked</Badge>
            )}
          </>
        ) : (
          <span className="text-muted-foreground text-sm">No company configured</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {company && (
          <span className="font-mono text-muted-foreground text-sm">
            £{company.treasury?.toLocaleString()}
          </span>
        )}
      </div>
    </header>
  );
}
