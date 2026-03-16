import type {
  BlendedPrice,
  CreateOrderRequest,
  FillOrderRequest,
  MarketOrder,
} from "@/lib/types";
import { api, fetchAllPages } from "./client";

export const marketApi = {
  getOrders: (portIds?: string[], goodIds?: string[], side?: "buy" | "sell") => {
    const params = new URLSearchParams();
    for (const id of portIds ?? []) params.append("port_ids[]", id);
    for (const id of goodIds ?? []) params.append("good_ids[]", id);
    if (side) params.set("side", side);
    const qs = params.toString();
    return fetchAllPages<MarketOrder>(`/market/orders${qs ? `?${qs}` : ""}`);
  },
  createOrder: (data: CreateOrderRequest) =>
    api.post<MarketOrder>("/market/orders", data),
  cancelOrder: (id: string) => api.delete<void>(`/market/orders/${id}`),
  fillOrder: (id: string, data: FillOrderRequest) =>
    api.post<void>(`/market/orders/${id}/fill`, data),
  getBlendedPrice: (portId: string, goodId: string) =>
    api.get<BlendedPrice>(
      `/market/blended-price?port_id=${portId}&good_id=${goodId}`,
    ),
};
