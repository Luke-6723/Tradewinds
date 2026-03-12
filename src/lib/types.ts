// TypeScript types generated from Tradewinds OpenAPI spec

// ─── Primitive helpers ─────────────────────────────────────────────────────
export type UUID = string;
export type ISO8601 = string;

// ─── Account / Auth ────────────────────────────────────────────────────────
export interface RegisterRequest {
  username: string;
  password: string;
  email: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
}

// ─── Company ───────────────────────────────────────────────────────────────
export interface Company {
  id: UUID;
  name: string;
  home_port_id: UUID;
  treasury: number;
  reputation: number;
  is_locked: boolean;
  created_at: ISO8601;
}

export interface CompanyEconomy {
  treasury: number;
  reputation: number;
  ship_upkeep: number;
  warehouse_upkeep: number;
  total_upkeep: number;
}

export interface LedgerEntry {
  id: UUID;
  company_id: UUID;
  amount: number;
  description: string;
  created_at: ISO8601;
}

export interface CreateCompanyRequest {
  name: string;
  home_port_id: UUID;
}

// ─── World ─────────────────────────────────────────────────────────────────
export interface Port {
  id: UUID;
  name: string;
  shortcode: string;
  country_id: UUID;
  is_hub: boolean;
  tax_rate_bps: number;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface Good {
  id: UUID;
  name: string;
  category: string;
  description?: string;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface Route {
  id: UUID;
  from_id: UUID;
  to_id: UUID;
  distance: number;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface ShipType {
  id: UUID;
  name: string;
  description?: string;
  capacity: number;
  speed: number;
  upkeep: number;
  base_price: number;
}

// ─── Trade ─────────────────────────────────────────────────────────────────
export interface TraderPosition {
  id: UUID;
  trader_id: UUID;
  port_id: UUID;
  good_id: UUID;
  stock_bounds: string;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface QuoteRequest {
  port_id: UUID;
  good_id: UUID;
  quantity: number;
  action: "buy" | "sell";
}

export interface Quote {
  token: string;
  action: "buy" | "sell";
  company_id: UUID;
  good_id: UUID;
  port_id: UUID;
  quantity: number;
  unit_price: number;
  total_price: number;
  timestamp: ISO8601;
  expires_at: ISO8601; // computed client-side: timestamp + 120s
}

export interface TradeDestination {
  type: "ship" | "warehouse";
  id: UUID;
  quantity: number;
}

export interface ExecuteQuoteRequest {
  token: string;
  destinations: TradeDestination[];
}

export interface DirectTradeRequest {
  trader_id: UUID;
  good_id: UUID;
  quantity: number;
  direction: "buy" | "sell";
  warehouse_id?: UUID;
}

// ─── Market (Order Book) ───────────────────────────────────────────────────
export interface MarketOrder {
  id: UUID;
  company_id: UUID;
  port_id: UUID;
  good_id: UUID;
  side: "buy" | "sell";
  price: number;
  total: number;
  remaining: number;
  status: "open" | "filled" | "cancelled" | "expired";
  posted_reputation: number;
  created_at: ISO8601;
  expires_at: ISO8601;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface CreateOrderRequest {
  port_id: UUID;
  good_id: UUID;
  side: "buy" | "sell";
  price: number;
  total: number;
}

export interface FillOrderRequest {
  quantity: number;
  warehouse_id?: UUID;
}

export interface BlendedPrice {
  good_id: UUID;
  port_id: UUID;
  blended_price: number;
}

// ─── Fleet ─────────────────────────────────────────────────────────────────
export interface Ship {
  id: UUID;
  name: string;
  status: "docked" | "traveling";
  company_id: UUID;
  ship_type_id: UUID;
  port_id: UUID | null;
  route_id: UUID | null;
  arriving_at: ISO8601 | null;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface RenameShipRequest {
  name: string;
}

export interface TransitRequest {
  route_id: UUID;
}

export interface TransferToWarehouseRequest {
  warehouse_id: UUID;
  good_id: UUID;
  quantity: number;
}

// ─── Warehouses / Logistics ────────────────────────────────────────────────
export interface Warehouse {
  id: UUID;
  company_id: UUID;
  port_id: UUID;
  level: number;
  capacity: number;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface BuyWarehouseRequest {
  port_id: UUID;
}

export interface TransferToShipRequest {
  ship_id: UUID;
  good_id: UUID;
  quantity: number;
}

// ─── Shipyards ─────────────────────────────────────────────────────────────
export interface Shipyard {
  id: UUID;
  port_id: UUID;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface ShipyardInventoryItem {
  id: UUID;
  shipyard_id: UUID;
  ship_type_id: UUID;
  ship_id: UUID;
  cost: number;
  inserted_at: ISO8601;
  updated_at: ISO8601;
}

export interface PurchaseShipRequest {
  ship_type_id: UUID;
  name: string;
}

// ─── SSE Events ────────────────────────────────────────────────────────────
export interface WorldEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: ISO8601;
}

export interface CompanyEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: ISO8601;
}

// ─── API response wrapper ──────────────────────────────────────────────────
export interface ApiError {
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
  status: number;
}
