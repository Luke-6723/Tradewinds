import type { Good, Port, Route, ShipType, PageMetadata } from "@/lib/types";
import { api, requestRaw } from "./client";

type Paginated<T> = { data: T[]; metadata: PageMetadata };

/** Fetch all pages of a cursor-paginated endpoint, returning a flat array. */
async function fetchAllPages<T>(baseUrl: string): Promise<T[]> {
  const results: T[] = [];
  let after: string | null = null;
  do {
    const url: string = after
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}after=${encodeURIComponent(after)}`
      : baseUrl;
    const page = await requestRaw<Paginated<T>>(url);
    results.push(...page.data);
    after = page.metadata?.after ?? null;
  } while (after);
  return results;
}

export const worldApi = {
  getPorts: () => api.get<Port[]>("/world/ports"),
  getPort: (id: string) => api.get<Port>(`/world/ports/${id}`),
  getGoods: () => api.get<Good[]>("/world/goods"),
  getRoutes: (fromId?: string): Promise<Route[]> =>
    fetchAllPages<Route>(`/world/routes${fromId ? `?from_id=${fromId}` : ""}`),
  getShipTypes: () => api.get<ShipType[]>("/world/ship-types"),
};
