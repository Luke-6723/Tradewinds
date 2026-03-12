import type {
  RenameShipRequest,
  Ship,
  TransferToWarehouseRequest,
  TransitRequest,
} from "@/lib/types";
import { api } from "./client";

export const fleetApi = {
  getShips: () => api.get<Ship[]>("/ships"),
  getShip: (id: string) => api.get<Ship>(`/ships/${id}`),
  renameShip: (id: string, data: RenameShipRequest) =>
    api.patch<Ship>(`/ships/${id}`, data),
  transit: (id: string, data: TransitRequest) =>
    api.post<Ship>(`/ships/${id}/transit`, data),
  transferToWarehouse: (id: string, data: TransferToWarehouseRequest) =>
    api.post<void>(`/ships/${id}/transfer-to-warehouse`, data),
};
