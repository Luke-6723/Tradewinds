import type { BoardPassengerRequest, Passenger } from "@/lib/types";
import { api } from "./client";

export const passengersApi = {
  getPassengers: (filters?: {
    status?: "available" | "boarded";
    port_id?: string;
    ship_id?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.port_id) params.set("port_id", filters.port_id);
    if (filters?.ship_id) params.set("ship_id", filters.ship_id);
    const qs = params.toString();
    return api.get<Passenger[]>(`/passengers${qs ? `?${qs}` : ""}`);
  },
  boardPassenger: (passengerId: string, data: BoardPassengerRequest) =>
    api.post<Passenger>(`/passengers/${passengerId}/board`, data),
};
