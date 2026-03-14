import type {
  ExecuteQuoteRequest,
  ExecuteTradeRequest,
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

export type BatchQuoteItem =
  | {
      status: "success";
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
      message?: string;
    }
  | { status: "error"; message: string; token?: never; quote?: never };

export type BatchExecuteItem =
  | {
      status: "success";
      token: string;
      execution: {
        action: "buy" | "sell";
        company_id: string;
        good_id: string;
        port_id: string;
        quantity: number;
        unit_price: number;
        total_price: number;
      };
      message?: string;
    }
  | { status: "error"; message: string; token?: never; execution?: never };

export const tradeApi = {
  getTraders: () =>
    api.get<{ id: string; name: string; inserted_at: string; updated_at: string }[]>("/trade/traders"),
  getTraderPositions: (traderId?: string) =>
    api.get<TraderPosition[]>(
      traderId ? `/trade/trader-positions?trader_id=${traderId}` : "/trade/trader-positions",
    ),
  createQuote: (data: QuoteRequest): Promise<Quote> =>
    api.post<RawQuoteData>("/trade/quote", data).then(({ token, quote }) => ({
      ...quote,
      token,
      expires_at: new Date(new Date(quote.timestamp).getTime() + 120_000).toISOString(),
    })),
  executeQuote: (data: ExecuteQuoteRequest) =>
    api.post<void>("/trade/quotes/execute", data),
  executeDirect: (data: ExecuteTradeRequest) =>
    api.post<void>("/trade/execute", data),
  batchCreateQuotes: (data: { requests: QuoteRequest[] }): Promise<BatchQuoteItem[]> =>
    api.post<BatchQuoteItem[]>("/trade/quotes/batch", data),
  batchExecuteQuotes: (data: { requests: ExecuteQuoteRequest[] }): Promise<BatchExecuteItem[]> =>
    api.post<BatchExecuteItem[]>("/trade/quotes/execute/batch", data),
};
