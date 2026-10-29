// TypeScript types for the kibb.io Tradewinds API (v1), from /api-docs/openapi.json.
// Only the fields the bot uses are listed. Money is integer pence, weight is tons.
// Every schema in full, generated: ./schema.ts (import type * as S from "@/lib/kibb/schema").

import type * as S from "./schema";

export type ShipStatus = "berthed" | "anchored_roadstead" | "sailing" | "sunk";
export type ZoneClass = "coastal" | "regional" | "oceanic";
export type OrderSide = "bid" | "ask";
export type TimeInForce = "ioc" | "gtc";
export type PortVisibility = "none" | "storage" | "counting_house" | "quay";
/**
 * `commission`: a hull ordered at a yard (`ship_class`, `reward_pence` = the price), not freight. `licence_offer` /
 * `licence_request`: licence units for a patented component (guide 3.19; `licence` on the listing), no port or goods.
 */
export type ContractType = "charter" | "freight" | "commission" | "licence_offer" | "licence_request";
export type ContractStatus = "open" | "active" | "completed" | "cancelled" | "defaulted";
/** Who pays a charter's deliveries: a world account, or (`issuer`) the player who posted it, from its escrow. */
export type CharterFunding = "crown" | "mint" | "issuer";
export type AccountType = "vault" | "escrow" | "crown" | "mint" | "venture";
export type BankingRegion =
  | "channel"
  | "north_sea"
  | "baltic"
  | "iberia"
  | "caribbean"
  | "indian_ocean"
  | "east_indies"
  /** The American colonies (Phase 2). */
  | "america";
/** `underworld`: everything under `/v1/underworld/*` (smuggling, guide 3.18); a trading key need not hold it. */
export type ApiKeyScope =
  | "read"
  | "fleet_navigate"
  | "fleet_cargo"
  | "market_spot"
  | "market_derivatives"
  | "infra_manage"
  | "treasury_remit"
  | "account_manage"
  | "underworld";
/** `contraband` lives only aboard ships: never on a market book, in a warehouse, freight, a charter or a pledge (guide 3.18). */
export type CommodityCategory = "provisions" | "raw_inputs" | "industrial_naval" | "european_trade" | "colonial_bullion" | "contraband";

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
  /** A news hull (the packet) whose owner may seal its dispatches (`POST /v1/fleet/seal-dispatches`). Merchant hulls always share. */
  can_seal_dispatches: boolean;
  /** Passengers a ton of hold carries (guide 3.20): one in a merchant hull, two in a packet. */
  passengers_per_ton: number;
}

export interface CatalogPort {
  id: string;
  name: string;
  banking_region: BankingRegion;
  sea_zone_id: string;
  phase: number;
  is_hub: boolean;
  has_shipyard: boolean;
  /** A smugglers' cove (guide 3.12, 3.18): ships' stores only, few berths, no Resident Factor (`403 no_factor_at_cove`). Absent: not one. */
  is_cove?: boolean;
  customs_bps: number;
  /**
   * A discount yard (guide 3.4: Lisbon, Boston, Havana): labour `labour_discount_bps` cheaper and no turnkey markup. Null or
   * absent elsewhere. A hull built there keeps the full rebuild value.
   */
  yard_discount?: S.YardDiscount | null;
  produces?: string[] | null;
  manufactures?: string[] | null;
  imports?: string[] | null;
}

export interface CatalogCommodity {
  id: string;
  name: string;
  category: CommodityCategory;
  base_price_pence: number;
}

export interface Catalog {
  ports: CatalogPort[];
  commodities: CatalogCommodity[];
  ship_classes: CatalogShipClass[];
  /** Catalog hazard odds (bps, 10,000 = 100%); optional here so a missing field falls back. */
  sea_zones: { id: string; name: string; zone_class: ZoneClass; phase: number; base_storm_bps?: number; base_piracy_bps?: number }[];
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
    /**
     * The best resting company order on each side (not the NPC ladder) and the tons left at that price;
     * null when none rested. Anonymous: they may be our own orders.
     */
    best_player_bid_pence?: number | null;
    best_player_bid_quantity?: number | null;
    best_player_ask_pence?: number | null;
    best_player_ask_quantity?: number | null;
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
  /** A discount yard's cut (as on `CatalogPort`); null or absent elsewhere. */
  yard_discount?: S.YardDiscount | null;
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
  /** Public forming convoys mustering here, and those elsewhere whose news has reached this quay; soonest first. Quay only. */
  convoy_notices?: S.ConvoyNotice[] | null;
  /** The Lloyd's List posted here: underwriters' recent results and the policies open here. Quay only. */
  lloyds_list?: S.LloydsListNotice | null;
}

/** `GET /v1/world/zones`: live piracy per sea zone. */
export interface SeaZoneStatus {
  sea_zone_id: string;
  name: string;
  phase: number;
  base_piracy_bps: number;
  marque_piracy_bps: number;
  patrol_suppression_bps: number;
  net_piracy_bps: number;
  active_marques: number;
  active_patrols: number;
}

export interface LeaderboardResult {
  season_number: number;
  ranked_players: number;
  refreshed_at?: string | null;
  next_refresh_at?: string | null;
  entries: { rank: number; company_name: string; home_port_id: string; net_worth_pence: number; titles: unknown[] }[];
  you?: { rank: number; company_name: string; net_worth_pence: number; is_calling_company: boolean } | null;
  /** Growth over the last 7 real days, all of a player's companies together (guide 3.17); display only. */
  rising: S.RisingBoard;
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
  /** Tons delivered to this charter across all its postings. */
  tons_delivered_total?: number;
  /** Delivered share of this charter's cap, in bps (spec; absent from older servers). */
  progress_bps?: number;
}

export interface ExpansionTier {
  target_phase: number;
  title: string;
  completed: boolean;
  completed_at?: string | null;
  /** Split among the contributors at completion by player, pro rata to the square root of each one's contribution: not by `share_bps`. */
  completion_bonus_pence: number;
  target_tons: number;
  /** `tons_per_company` per active trading company, at least `min_tons` (spec; absent from older servers). */
  tons_per_company?: number;
  min_tons?: number;
  tons_delivered: number;
  tons_remaining: number;
  progress_bps: number;
  active_companies: number;
  /** Tons the open charters still accept, combined (spec; absent from older servers). */
  charter_capacity_tons?: number;
  charters: ExpansionCharterProgress[];
  /** Every contributor, largest share first (ExpansionContributor). */
  contributors?: ExpansionContributor[];
}

/**
 * One company on a tier's contribution board: tons delivered, and `share_bps`, its share of the tier's contribution (tons valued
 * at the tier's base rates). Not the share of the bonus: that splits by the square root of each player's base-valued tons (across
 * the player's companies), so a large contributor's share of the bonus is smaller. `bonus_pence` / `bonus_share_bps` come from
 * the admin API only (null or absent in public answers).
 */
export interface ExpansionContributor {
  company_name: string;
  tons: number;
  share_bps: number;
  bonus_pence?: number | null;
  bonus_share_bps?: number | null;
}

export interface ExpansionStatus {
  unlocked_phase: number;
  active_trading_companies: number;
  current_tier?: ExpansionTier | null;
}

// ── Fleet ─────────────────────────────────────────────────────────────────────

/**
 * Liens and arrest are not on the ship: a lien is a loan's `collateral_ship_id` (`S.Loan`, `collateral_kind:
 * ship_lien`); a defaulted loan's ship is arrested (`409 conflict` on depart or joining a convoy) until settled.
 */
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
  /**
   * Hold the passengers aboard take (guide 3.20): not cargo, but it cuts what she can load and weighs her down like cargo.
   * `effective_hold_capacity_tons` already leaves it out.
   */
  passenger_hold_tons: number;
  /** A packet's sealed dispatches: its crew's gossip is not posted to the boards it calls at. */
  dispatches_sealed: boolean;
  created_at?: string;
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
  /** Components fitted to the hull (guide 3.19): they raise its rebuild value. Absent from older answers. */
  components?: S.FittedComponentView[];
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
  route_legs: RouteLeg[];
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
  /** The port's berth dues a game day at its occupancy when this call berthed the ship (only when it did). */
  berth_dues_per_day_pence?: number | null;
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
  /** Freight only: who is carrying it once accepted. Commissions: the builder once accepted. */
  carrier_company_id?: string | null;
  /**
   * Who posted it (freight and player charters: the issuer; commissions: the buyer; Crown and governor
   * charters: null). A player charter's issuer, and its player's other and linked companies, can't deliver.
   */
  issuer_company_id?: string | null;
  carrier_ship_id?: string | null;
  title?: string | null;
  /** Charters: who pays deliveries (`issuer`: a player charter, the goods going to its warehouse, no prestige). Freight: null. */
  funded_by?: CharterFunding | null;
  /** Commissions: the hull ordered (built at `origin_port_id`). Null otherwise. */
  ship_class?: string | null;
  /** True when this is second-hand news; `remaining_quantity` may be out of date. */
  stale: boolean;
  gossip?: { age_seconds: number; heard_at_port_id: string; news_as_of: string } | null;
  /** When it was posted (a gossiped copy keeps the real posting time). */
  created_at?: string;
  /** The raw record (`charter_kind`, `funded_by`, …). */
  metadata?: Record<string, unknown> | null;
  /** Licence contracts only: the design, its price terms and what making one takes. */
  licence?: S.LicenceTerms | null;
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

export interface AcceptFreightResult {
  contract_id: string;
  carrier_ship_id: string;
  origin_port_id: string;
  dest_port_id: string;
  commodity_id: string;
  quantity: number;
  reward_pence: number;
  collateral_pence: number;
  delivery_deadline: string;
  status: ContractStatus;
}

export interface DeliverFreightResult {
  contract_id: string;
  dest_port_id: string;
  commodity_id: string;
  delivered_quantity: number;
  reward_paid_pence: number;
  collateral_returned_pence: number;
}

// ── Shipyard ──────────────────────────────────────────────────────────────────

export type BuildMode = "byom" | "turnkey_cash";

/**
 * `GET /v1/shipyard/quote`. Turnkey buys each material off the port's ask book (players' asks and the NPC
 * ladder, cheapest first; our own and sibling asks and asks over 2.5x the mid passed over), pays customs on
 * every fill, and marks up only the NPC-sourced part. BYOM: labour only (materials, customs and markup 0). At a discount
 * yard (`yard_discount`) the labour cut and the waived markup are already taken off.
 */
export interface BuildQuote {
  port_id: string;
  ship_class: string;
  build_mode: BuildMode;
  available: boolean;
  /** Shipwright labour, charged in every mode (less a discount yard's cut). */
  labour_pence: number;
  /** Turnkey: sum of the materials' `cost_pence`, paid to the sellers (before customs and markup). */
  materials_pence: number;
  /** Turnkey: the part of `materials_pence` bought off the NPC ladder (what the markup is charged on). */
  npc_materials_pence: number;
  /** Turnkey: sum of the materials' importer customs. */
  customs_pence: number;
  /** Markup on `npc_materials_pence` (`1,500` = 15%; 0 at a yard that waives it). */
  yard_markup_bps: number;
  yard_markup_pence: number;
  /** `labour + materials + customs + markup`; null when a turnkey material cannot be supplied. */
  total_cost_pence?: number | null;
  /** The discount this yard gives (guide 3.4), already in the figures above; null or absent elsewhere. */
  yard_discount?: S.YardDiscount | null;
  /**
   * What a ship mortgage on this build would lend (guide 3.4): 60% of the price, 80% for an oceanic hull, amortised over 180
   * game days. `available: false` while we still owe on one (one at a time). Null when the build can't be priced now.
   */
  mortgage?: S.MortgageTerms | null;
  materials: {
    commodity_id: string;
    quantity: number;
    /** Turnkey: the asks we may buy from and the NPC stockpile cover `quantity`. BYOM: our warehouse here holds it unlocked. */
    in_stock: boolean;
    /** Turnkey: paid to the sellers for `quantity`; null if the book can't supply it all. BYOM: null. */
    cost_pence?: number | null;
    /** Turnkey: the part of `cost_pence` bought from the NPC merchants. BYOM: null. */
    npc_cost_pence?: number | null;
    /** Turnkey: importer customs on `cost_pence`. BYOM: null. */
    customs_pence?: number | null;
    /** Turnkey: tons bought from players' asks, and from the NPC merchants. BYOM: 0. */
    player_tons: number;
    npc_tons: number;
  }[];
}

export interface BuildShipResult {
  ship_id: string;
  name: string;
  port_id: string;
  ship_class: string;
  build_mode: BuildMode;
  status: ShipStatus;
  /** The build's whole price. With a mortgage the Goldsmiths paid `mortgage.principal_pence` of it; our vault paid the rest. */
  total_cost_pence: number;
  /** The ship mortgage taken with the build (`mortgage: true`; `is_mortgage`, a `ship_lien` on the new hull); null or absent without. */
  mortgage?: S.Loan | null;
}

// ── Treasury ──────────────────────────────────────────────────────────────────

export interface AchRate {
  from_region: BankingRegion;
  to_region: BankingRegion;
  fee_bps: number;
}

export interface RemitResult {
  from_region: BankingRegion;
  to_region: BankingRegion;
  gross_amount_pence: number;
  fee_bps: number;
  fee_pence: number;
  net_credited_pence: number;
}

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

// ── Event payloads (guide 4.4) ────────────────────────────────────────────────
// The spec leaves `StreamEvent.payload` untyped. Only the fields the guide names are certain; every field is optional and
// read defensively (as the manager's `str`/`num` do). The other keys here are the likely ones, not published.

/** `passengers_lost` `cause` (guide 4.4). */
export type PassengersLostCause = "sunk" | "captured" | "seized" | "ship_changed_hands" | "overdue";

/**
 * `passengers_boarded`: a group took our offer. The guide names heads, fare and `promised_arrival_at`; the group's own fields
 * are assumed. `passengersAboard` is the authority on what is aboard.
 */
export type PassengersBoardedPayload = Partial<S.AboardGroupView> & { ship_id?: string; offer_id?: string; group_id?: string };

/** `passengers_paid`: a group's fare on arrival (`fare_paid_pence`, `game_days_late` named by the guide), into that port's region. */
export interface PassengersPaidPayload {
  fare_paid_pence?: number;
  game_days_late?: number;
  ship_id?: string;
  group_id?: string;
  dest_port_id?: string;
  size?: number;
}

/** `passengers_lost`: a group gone, unpaid (`cause` named by the guide). */
export interface PassengersLostPayload {
  cause?: PassengersLostCause;
  ship_id?: string;
  group_id?: string;
  size?: number;
}

/** `bulletin_posted` (public): every field named by the guide. */
export interface BulletinPostedPayload {
  thread_id?: string;
  post_id?: string;
  title?: string;
  company_name?: string;
  body?: string;
  is_reply?: boolean;
  link?: S.BulletinLink | null;
}

/** `exchange_posted` (public): an entry as `GET /v1/exchange` lists it (a new offer, or a bank's new terms). */
export type ExchangePostedPayload = Partial<S.ExchangeEntry>;

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
