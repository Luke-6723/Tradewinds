import type {
  DirectTradeRequest,
  ExecuteQuoteRequest,
  Quote,
  QuoteRequest,
  TraderPosition,
} from "@/lib/types";
import { api } from "./client";

type RawQuoteData = {
  token: string;
  quote: {
    action: "buy" | "sell";
    company_id: string;
    good_id: string;
    port_id: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    timestamp: string;
  };
};

export const tradeApi = {
  getTraderPositions: (portId?: string) =>
    api.get<TraderPosition[]>(
      portId ? `/trade/trader-positions?port_id=${portId}` : "/trade/trader-positions",
    ),
  createQuote: (data: QuoteRequest): Promise<Quote> =>
    api.post<RawQuoteData>("/trade/quote", data).then(({ token, quote }) => ({
      ...quote,
      token,
      expires_at: new Date(new Date(quote.timestamp).getTime() + 120_000).toISOString(),
    })),
  executeQuote: (data: ExecuteQuoteRequest) =>
    api.post<void>("/trade/quotes/execute", data),
  executeDirect: (data: DirectTradeRequest) =>
    api.post<void>("/trade/execute", data),
};
