import type { Good, Port, Route, ShipType } from "@/lib/types";
import { api, fetchAllPages } from "./client";

export const worldApi = {
  getPorts: (): Promise<Port[]> => fetchAllPages<Port>("/world/ports"),
  getPort: (id: string) => api.get<Port>(`/world/ports/${id}`),
  getGoods: () => api.get<Good[]>("/world/goods"),
  getRoutes: (fromId?: string): Promise<Route[]> =>
    fetchAllPages<Route>(`/world/routes${fromId ? `?from_id=${fromId}` : ""}`),
  getShipTypes: () => api.get<ShipType[]>("/world/ship-types"),
};
