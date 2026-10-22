// TypeScript types for the kibb.io Tradewinds API (v1), from /api-docs/openapi.json.
// Only the fields the bot uses are listed. Money is integer pence, weight is tons.

export type ShipStatus = "berthed" | "anchored_roadstead" | "sailing" | "sunk";
export type ZoneClass = "coastal" | "regional" | "oceanic";
export type OrderSide = "bid" | "ask";
export type TimeInForce = "ioc" | "gtc";
export type PortVisibility = "none" | "storage" | "counting_house" | "quay";
export type ContractType = "charter" | "freight";
export type ContractStatus = "open" | "active" | "completed" | "cancelled" | "defaulted";
export type AccountType = "vault" | "escrow" | "crown" | "mint";
export type BankingRegion =
  | "channel"
  | "north_sea"
  | "baltic"
  | "iberia"
  | "caribbean"
  | "indian_ocean"
  | "east_indies";
export type ApiKeyScope =
  | "read"
  | "fleet_navigate"
  | "fleet_cargo"
  | "market_spot"
  | "market_derivatives"
  | "infra_manage"
  | "treasury_remit"
  | "account_manage";

// ── Auth / player / company ───────────────────────────────────────────────────

export interface Player {
  id: string;
  handle: string;
  created_at: string;
}

export interface Company {
  id: string;
  player_id: string;
  name: string;
  home_port_id: string;
  crown_prestige: number;
  created_at: string;
}

export interface ApiKeyInfo {
  id: string;
  player_id: string;
  company_id?: string | null;
  label: string;
  scopes: ApiKeyScope[];
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
}

export interface LoginRequest {
  handle: string;
  passphrase: string;
  company_id?: string;
  label?: string;
  scopes?: ApiKeyScope[];
  ttl_seconds?: number;
}

export interface CreateKeyRequest {
  label: string;
  scopes: ApiKeyScope[];
  company_id?: string;
  ttl_seconds?: number;
}

/** `api_key` is the plaintext key, returned only once. */
export interface CreateKeyResult {
  api_key: string;
  key: ApiKeyInfo;
}

export interface PlayerProfile {
  player: Player;
  companies: Company[];
}

export interface CreateCompanyRequest {
  name: string;
  home_port_id: string;
  starter_ship_name?: string;
}

export interface CreateCompanyResult {
  company: Company;
  home_banking_region: BankingRegion;
  seed_capital_pence: number;
  starter_ship_id: string;
}

export interface CompanyProfile {
  company: Company;
  handle: string;
  fleet_count: number;
  factor_ports: string[];
  vaults: VaultBalance[];
}

export interface WhoAmI {
  api_key_id: string;
  player_id: string;
  company_id?: string | null;
  expires_at?: string | null;
  scopes: ApiKeyScope[];
}

export interface WorldClock {
  real_utc: string;
  season_number: number;
  unlocked_phase: number;
  paused: boolean;
  season_planned_end_at?: string | null;
  calendar: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    season: "spring" | "summer" | "autumn" | "winter";
    time_scale: number;
    total_game_hours: number;
  };
}

export interface CatalogShipClass {
  id: string;
  name: string;
  hull_category: ZoneClass;
  phase: number;
  base_speed_centiknots: number;
  hold_capacity_tons: number;
  max_cannons: number;
  crew_required: number;
}

export interface CatalogPort {
  id: string;
  name: string;
  banking_region: BankingRegion;
  sea_zone_id: string;
  phase: number;
  is_hub: boolean;
  has_shipyard: boolean;
  customs_bps: number;
  produces?: string[] | null;
  manufactures?: string[] | null;
  imports?: string[] | null;
}

export interface CatalogCommodity {
  id: string;
  name: string;
  category: string;
  base_price_pence: number;
}

export interface Catalog {
  ports: CatalogPort[];
  commodities: CatalogCommodity[];
  ship_classes: CatalogShipClass[];
  sea_zones: { id: string; name: string; zone_class: ZoneClass; phase: number }[];
}

export interface GossipReport {
  subject_port_id: string;
  age_seconds: number;
  snapshot_at: string;
  commodities: {
    commodity_id: string;
    current_stock: number;
    best_bid_pence?: number | null;
    best_ask_pence?: number | null;
  }[];
}

export interface SailingNotice {
  port_id: string;
  direction: "sailed" | "arrived";
  ship_name: string;
  ship_class: string;
  company_name: string;
  other_port_id?: string | null;
  convoy_name?: string | null;
  load_state: "ballast" | "part_laden" | "laden";
  seen_at: string;
}

export interface PortDetail {
  id: string;
  name: string;
  banking_region: BankingRegion;
  sea_zone_id: string;
  phase: number;
  is_hub: boolean;
  has_shipyard: boolean;
  customs_bps: number;
  base_customs_bps: number;
  base_berths: number;
  effective_berths: number;
  occupied_berths: number;
  queued_ships: number;
  berth_dues_per_day_pence: number;
  health_score_bps: number;
  total_warehouse_cap: number;
  total_leased_warehouse: number;
  counting_house_min_lease_tons: number;
  rolling_player_volume_tons: number;
  rolling_player_turnover_pence: number;
  visibility: PortVisibility;
  /** Only at quay visibility. */
  coffee_house_gossip?: GossipReport[] | null;
  recent_sailings?: SailingNotice[] | null;
}

export interface LeaderboardResult {
  season_number: number;
  ranked_players: number;
  refreshed_at?: string | null;
  next_refresh_at?: string | null;
  entries: { rank: number; company_name: string; home_port_id: string; net_worth_pence: number; titles: unknown[] }[];
  you?: { rank: number; company_name: string; net_worth_pence: number; is_calling_company: boolean } | null;
}

export interface RouteLeg {
  from_node: string;
  to_node: string;
  distance_nm: number;
  edge_class: ZoneClass;
  is_sound_toll: boolean;
}

export interface RoutePlan {
  from_port: string;
  to_port: string;
  ship_class: string;
  total_distance_nm: number;
  expected_provisions_tons: number;
  safe_provisions_tons: number;
  port_provisions_tons_per_day: number;
  legs: RouteLeg[];
}

export interface ExpansionCharterProgress {
  contract_id: string;
  port_id: string;
  commodity_id: string;
  status: ContractStatus;
  quantity_required: number;
  quantity_delivered: number;
  quantity_remaining: number;
  reward_per_ton_pence: number;
  premium_bps: number;
  beyond_coastal_water: boolean;
  escalations: number;
  game_hours_left: number;
  expires_at?: string | null;
}

export interface ExpansionTier {
  target_phase: number;
  title: string;
  completed: boolean;
  completion_bonus_pence: number;
  target_tons: number;
  tons_delivered: number;
  tons_remaining: number;
  progress_bps: number;
  active_companies: number;
  charters: ExpansionCharterProgress[];
}

export interface ExpansionStatus {
  unlocked_phase: number;
  active_trading_companies: number;
  current_tier?: ExpansionTier | null;
}

// ── Fleet ─────────────────────────────────────────────────────────────────────

export interface Ship {
  id: string;
  name: string;
  company_id: string;
  ship_class: string;
  status: ShipStatus;
  current_port_id?: string | null;
  berthed_at?: string | null;
  dock_queued_at?: string | null;
  turnaround_unlocks_at?: string | null;
  leg_departs_at?: string | null;
  leg_arrives_at?: string | null;
  current_leg_idx: number;
  cannons_count: number;
  convoy_id?: string | null;
  stores_provisions_units: number;
}

export interface LegEstimate {
  leg_idx: number;
  from_node: string;
  to_node: string;
  distance_nm: number;
  speed_centiknots: number;
  estimated_arrival_at: string;
  starving: boolean;
}

export interface ShipResult {
  ship: Ship;
  hold_capacity_tons: number;
  effective_hold_capacity_tons: number;
  cargo_used_tons: number;
  /** Commodity id → tons in the hold. Stores are not included. */
  cargo_manifest: Record<string, number>;
  stores: { provisions_tons: number; sea_days_remaining: number };
  route_legs: RouteLeg[];
  voyage?: {
    current_leg_idx: number;
    estimated_arrival_at: string;
    speed_centiknots: number;
    legs: LegEstimate[];
  } | null;
}

export interface DepartRequest {
  ship_id: string;
  dest_port_id: string;
  allow_starvation?: boolean;
}

export interface DepartWarning {
  code: string;
  detail: string;
  required_tons: number;
  safe_tons: number;
  have_tons: number;
  buy_tons: number;
}

export interface DepartResult {
  ship_id: string;
  status: ShipStatus;
  origin_port_id: string;
  dest_port_id: string;
  estimated_arrival_at: string;
  speed_centiknots: number;
  berth_dues_pence: number;
  berth_dues_debt_pence: number;
  warnings: DepartWarning[];
}

export interface DockActionResult {
  ship_id: string;
  port_id: string;
  status: ShipStatus;
  berthed_at?: string | null;
  dock_queued_at?: string | null;
  queue_position?: number | null;
  turnaround_unlocks_at?: string | null;
  berth_dues_pence?: number | null;
}

export interface StoresTransferResult {
  ship_id: string;
  port_id: string;
  cargo_manifest: Record<string, number>;
  effective_hold_capacity_tons: number;
  stores: { provisions_tons: number; sea_days_remaining: number };
  turnaround_unlocks_at?: string | null;
}

// ── Market ────────────────────────────────────────────────────────────────────

export interface TopOfBookLevel {
  price_pence: number;
  quantity: number;
}

export interface OrderBookLevel {
  order_id: string;
  side: OrderSide;
  price_pence: number;
  remaining_quantity: number;
  is_npc: boolean;
  created_at: string;
}

export interface CommodityBook {
  commodity_id: string;
  best_bid?: TopOfBookLevel | null;
  best_ask?: TopOfBookLevel | null;
  /** Only at quay visibility. */
  depth?: { npc_current_stock: number; bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null;
}

export interface PortOrderBook {
  port_id: string;
  visibility: PortVisibility;
  customs_bps: number;
  as_of?: string | null;
  books: CommodityBook[];
}

export interface PlaceOrderRequest {
  port_id: string;
  commodity_id: string;
  side: OrderSide;
  time_in_force: TimeInForce;
  price_pence: number;
  quantity: number;
  ship_id?: string;
  into_stores?: boolean;
}

export interface PlaceOrderResult {
  order_id?: string | null;
  port_id: string;
  commodity_id: string;
  side: OrderSide;
  requested_quantity: number;
  filled_quantity: number;
  resting_quantity: number;
  total_gross_pence: number;
  customs_duty_pence: number;
}

// ── Contracts ─────────────────────────────────────────────────────────────────

export interface ContractListing {
  id: string;
  contract_type: ContractType;
  status: ContractStatus;
  is_public: boolean;
  /** For a charter, the port the goods must be delivered to. */
  origin_port_id: string;
  dest_port_id?: string | null;
  commodity_id?: string | null;
  quantity_required: number;
  quantity_delivered: number;
  remaining_quantity: number;
  reward_pence: number;
  reward_per_ton_pence?: number | null;
  collateral_pence: number;
  expires_at?: string | null;
  title?: string | null;
  funded_by?: "crown" | "mint" | null;
  /** True when this is second-hand news; `remaining_quantity` may be out of date. */
  stale: boolean;
  gossip?: { age_seconds: number; heard_at_port_id: string; news_as_of: string } | null;
}

export interface ContractListFilter {
  contract_type?: ContractType;
  port_id?: string;
  dest_port_id?: string;
  commodity_id?: string;
  status?: ContractStatus;
  cursor?: string;
  limit?: number;
}

export interface DeliverCharterRequest {
  contract_id: string;
  quantity: number;
  ship_id: string;
}

export interface DeliverCharterResult {
  contract_id: string;
  port_id: string;
  commodity_id: string;
  contract_status: ContractStatus;
  delivered_quantity: number;
  reward_paid_pence: number;
  prestige_awarded: number;
  unlocked_phase: number;
}

// ── Treasury ──────────────────────────────────────────────────────────────────

export interface VaultBalance {
  account_id: string;
  account_type: AccountType;
  banking_region: BankingRegion;
  balance_pence: number;
}

export interface TreasuryVaults {
  company_id: string;
  vaults: VaultBalance[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** `application/problem+json` error body. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  code?: string;
  [extra: string]: unknown;
}
