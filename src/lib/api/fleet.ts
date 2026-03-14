import type {
  Cargo,
  PageMetadata,
  RenameShipRequest,
  Ship,
  TransferToWarehouseRequest,
  TransitLog,
  TransitRequest,
} from "@/lib/types";
import { api, fetchAllPages } from "./client";
import { getCached, invalidateCache, setCached } from "./cache";

export const fleetApi = {
  getShips: (): Promise<Ship[]> => fetchAllPages<Ship>("/ships"),
  getShip: (id: string) => api.get<Ship>(`/ships/${id}`),
  getInventory: (id: string) => api.get<Cargo[]>(`/ships/${id}/inventory`),

  /**
   * Like getInventory, but caches the result until the ship docks when the
   * ship is currently traveling (cargo cannot change mid-transit).
   * Falls through to a live fetch for docked ships.
   */
  getInventoryCached: async (ship: Ship): Promise<Cargo[]> => {
    if (ship.status === "traveling" && ship.arriving_at) {
      const ttlMs = new Date(ship.arriving_at).getTime() - Date.now();
      if (ttlMs > 0) {
        const cacheKey = `inventory_${ship.id}`;
        const cached = getCached<Cargo[]>(cacheKey);
        if (cached) return cached;
        const data = await api.get<Cargo[]>(`/ships/${ship.id}/inventory`);
        setCached(cacheKey, data, ttlMs);
        return data;
      }
    }
    return api.get<Cargo[]>(`/ships/${ship.id}/inventory`);
  },

  getTransitLogs: (id: string) =>
    api.get<{ data: TransitLog[]; metadata: PageMetadata }>(`/ships/${id}/transit-logs`),
  renameShip: (id: string, data: RenameShipRequest) =>
    api.patch<Ship>(`/ships/${id}`, data),
  transit: (id: string, data: TransitRequest) =>
    api.post<Ship>(`/ships/${id}/transit`, data),
  transferToWarehouse: async (id: string, data: TransferToWarehouseRequest) => {
    const result = await api.post<void>(`/ships/${id}/transfer-to-warehouse`, data);
    invalidateCache(`inventory_${id}`);
    return result;
  },
};
