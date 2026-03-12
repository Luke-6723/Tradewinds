import type {
  PurchaseShipRequest,
  Ship,
  Shipyard,
  ShipyardInventoryItem,
} from "@/lib/types";
import { api } from "./client";

export const shipyardsApi = {
  getPortShipyard: (portId: string) =>
    api.get<Shipyard>(`/world/ports/${portId}/shipyard`),
  getInventory: (shipyardId: string) =>
    api.get<ShipyardInventoryItem[]>(`/shipyards/${shipyardId}/inventory`),
  purchaseShip: (shipyardId: string, data: PurchaseShipRequest) =>
    api.post<Ship>(`/shipyards/${shipyardId}/purchase`, data),
};
