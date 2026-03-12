import type { Good, Port, Route, ShipType } from "@/lib/types";
import { api } from "./client";

export const worldApi = {
  getPorts: () => api.get<Port[]>("/world/ports"),
  getPort: (id: string) => api.get<Port>(`/world/ports/${id}`),
  getGoods: () => api.get<Good[]>("/world/goods"),
  getRoutes: (fromId?: string) =>
    api.get<Route[]>(`/world/routes${fromId ? `?from_id=${fromId}` : ""}`),
  getShipTypes: () => api.get<ShipType[]>("/world/ship-types"),
};
