import type { Good, Port, Route, ShipType } from "@/lib/types";
import { api, fetchAllPages } from "./client";
import { getCached, setCached } from "./cache";

const TTL_PORTS = 15 * 60 * 1000;
const TTL_GOODS = 30 * 60 * 1000;
const TTL_SHIP_TYPES = 60 * 60 * 1000;
const TTL_ROUTES = 15 * 60 * 1000;

export const worldApi = {
  getPorts: async (): Promise<Port[]> => {
    const cached = getCached<Port[]>("ports");
    if (cached) return cached;
    const data = await fetchAllPages<Port>("/world/ports");
    setCached("ports", data, TTL_PORTS);
    return data;
  },

  getPort: (id: string) => api.get<Port>(`/world/ports/${id}`),

  getGoods: async (): Promise<Good[]> => {
    const cached = getCached<Good[]>("goods");
    if (cached) return cached;
    const data = await api.get<Good[]>("/world/goods");
    setCached("goods", data, TTL_GOODS);
    return data;
  },

  getRoutes: async (fromId?: string): Promise<Route[]> => {
    const cacheKey = fromId ? `routes_${fromId}` : "routes_all";
    const cached = getCached<Route[]>(cacheKey);
    if (cached) return cached;
    const data = await fetchAllPages<Route>(`/world/routes${fromId ? `?from_id=${fromId}` : ""}`);
    setCached(cacheKey, data, TTL_ROUTES);
    return data;
  },

  getShipTypes: async (): Promise<ShipType[]> => {
    const cached = getCached<ShipType[]>("ship_types");
    if (cached) return cached;
    const data = await api.get<ShipType[]>("/world/ship-types");
    setCached("ship_types", data, TTL_SHIP_TYPES);
    return data;
  },
};
