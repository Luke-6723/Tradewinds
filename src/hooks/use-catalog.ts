"use client";

import { useEffect, useState } from "react";
import { kibbGet } from "@/lib/kibb/browser";
import { titleCase } from "@/lib/kibb/format";
import type { Catalog } from "@/lib/kibb/types";

// The catalog is static for a world: fetch once per page load.
let cached: Promise<Catalog> | null = null;

function loadCatalog(): Promise<Catalog> {
  cached ??= kibbGet<Catalog>("/v1/world/catalog").catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

export interface CatalogHelpers {
  catalog: Catalog | null;
  portName: (id: string | null | undefined) => string;
  goodName: (id: string | null | undefined) => string;
  shipClassName: (id: string | null | undefined) => string;
}

export function useCatalog(): CatalogHelpers {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    loadCatalog().then(setCatalog).catch(() => undefined);
  }, []);

  const name = (list: { id: string; name: string }[] | undefined, id: string | null | undefined) =>
    id ? (list?.find((x) => x.id === id)?.name ?? titleCase(id)) : "—";

  return {
    catalog,
    portName: (id) => name(catalog?.ports, id),
    goodName: (id) => name(catalog?.commodities, id),
    shipClassName: (id) => name(catalog?.ship_classes, id),
  };
}
