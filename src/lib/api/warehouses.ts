import type {
  BuyWarehouseRequest,
  TransferToShipRequest,
  Warehouse,
  WarehouseInventory,
} from "@/lib/types";
import { api, fetchAllPages } from "./client";

export const warehousesApi = {
  getWarehouses: () => api.get<Warehouse[]>("/warehouses"),
  getWarehouse: (id: string) => api.get<Warehouse>(`/warehouses/${id}`),
  getInventory: (id: string) =>
    fetchAllPages<WarehouseInventory>(`/warehouses/${id}/inventory`),
  buyWarehouse: (data: BuyWarehouseRequest) =>
    api.post<Warehouse>("/warehouses", data),
  growWarehouse: (id: string) => api.post<Warehouse>(`/warehouses/${id}/grow`),
  shrinkWarehouse: (id: string) =>
    api.post<Warehouse>(`/warehouses/${id}/shrink`),
  transferToShip: (id: string, data: TransferToShipRequest) =>
    api.post<void>(`/warehouses/${id}/transfer-to-ship`, data),
};
