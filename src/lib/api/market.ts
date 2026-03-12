import type {
  BlendedPrice,
  CreateOrderRequest,
  FillOrderRequest,
  MarketOrder,
} from "@/lib/types";
import { api } from "./client";

export const marketApi = {
  getOrders: (portId?: string, goodId?: string) => {
    const params = new URLSearchParams();
    if (portId) params.set("port_id", portId);
    if (goodId) params.set("good_id", goodId);
    const qs = params.toString();
    return api.get<MarketOrder[]>(`/market/orders${qs ? `?${qs}` : ""}`);
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
