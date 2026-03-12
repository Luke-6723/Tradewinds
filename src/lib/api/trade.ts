import type {
  DirectTradeRequest,
  ExecuteQuoteRequest,
  Quote,
  QuoteRequest,
  TraderPosition,
} from "@/lib/types";
import { api } from "./client";

export const tradeApi = {
  getTraderPositions: (portId?: string) =>
    api.get<TraderPosition[]>(
      portId ? `/trade/trader-positions?port_id=${portId}` : "/trade/trader-positions",
    ),
  createQuote: (data: QuoteRequest) => api.post<Quote>("/trade/quote", data),
  executeQuote: (data: ExecuteQuoteRequest) =>
    api.post<void>("/trade/quotes/execute", data),
  executeDirect: (data: DirectTradeRequest) =>
    api.post<void>("/trade/execute", data),
};
