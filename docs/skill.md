---
name: tradewinds-player
description: Guide for playing Tradewinds, a headless Age of Sail trading game over an HTTP JSON API (default http://localhost:8080). Covers registering, scoped API keys, founding a company, trading on port order books, sailing ships safely (stores, hulls, winter), building, buying and selling ships, charters, freight, insurance and the Lloyd's List, marques and patrols, convoys, royal monopolies, sealed intelligence envelopes, player finance (loans, the credit board, banks, commenda ventures, ship shares), expansion, upkeep and bankruptcy, plus a reliable bot loop (Idempotency-Key, rate limits, SSE events).
---

# Tradewinds: player and bot guide

Tradewinds is a persistent, real-time trading simulation. Your company buys goods in one port, carries them by ship and sells them in another, all over HTTP JSON under `/v1`. The world keeps running while you are away.

- Base URL `http://localhost:8080` (server `BIND_ADDR`). This guide is served at `GET /skill.md`; `GET /` (and `GET /v1`) returns a JSON index of links. OpenAPI: `GET /api-docs/openapi.json`; Swagger UI: `/swagger-ui`; health: `GET /healthz`.
- Units: money is integer **pence** (100 p = 1 Crown, Cr); weight is **tons**; speed is **centiknots** (`850` = 8.5 kn); rates are **bps** (10,000 = 100%).
- Timestamps are real UTC. Game time runs `time_scale` times faster (default 60: 1 real minute = 1 game hour, 1 game day = 24 real minutes).
- Static data (42 ports, 42 commodities with reference prices and recipes, 9 ship classes, 29 sea zones) lives in **`GET /v1/world/catalog`**, not here. Fetch it once at startup.

> ## Golden rules: what kills companies
>
> 1. **Stock stores to `safe_provisions_tons`, not the minimum.** `GET /v1/world/route?from=&to=&ship_class=` returns `expected_provisions_tons` (the bare need: what is eaten before the last leg sets out) and `safe_provisions_tons` (survives one storm, which destroys 25% of the stores, on any leg; pirates who let a ship go take 20–50%). Both are fractional tons; buy the difference from your ship's `stores.provisions_tons`, rounded up to whole tons. `depart` only refuses below the exact no-hazard need; below the safe figure it sails but returns `warnings: [{code: "stores_below_safe", required_tons, safe_tons, have_tons, buy_tons}]` (`buy_tons`: whole tons to buy to reach the safe figure), so check `warnings`. A crew that runs out sails at half speed, loses 20% of every cargo stack per leg, and from the second leg on has a **50% chance per leg to mutiny**: ship, cargo and stores are lost, and the insurance closes `settled_safe` with **no payout**. Ships in port also eat stores at half the sea rate, a ton per 200 crew-days (a hoy's crew of 10: a ton every 20 game days; the route's `port_provisions_tons_per_day`).
> 2. **Keep cash for the next stores and the daily upkeep.** Rent, fleet upkeep and factor fees are billed every game day. If you can't pay, the Crown bailiff distress-sells your goods at half the reference price, dismisses factors and seizes idle ships. Never spend a region's vault to zero.
> 3. **Match the hull to the water.** Each ship class has a `hull_category` and each sea zone a `zone_class` (`coastal` < `regional` < `oceanic`) in the catalog. A hull rated for a zone rarely sinks there. One class too small takes storm damage on most legs and has a real chance of sinking. Two classes too small (a coastal hoy in oceanic water) is close to suicide. Check **every** zone on the route (`/v1/world/route` lists them: each `legs[].to_node` but the last is a sea zone id).
> 4. **Respect winter.** Game months 11, 12, 1 and 2 are storm season, with markedly worse storm odds everywhere. A fresh world starts on 1 March (spring), eight months before storm season.
> 5. **Send `Idempotency-Key` on every POST and PATCH.** Use a fresh key per logical action. Reuse a key only to retry after a timeout, network error or 5xx. 4xx answers are stored and replayed, so after a `409` or `400` use a new key.
> 6. **Respect rate limits.** On `429` sleep for `Retry-After` seconds. Login, register and key minting share a tiny bucket (20 burst, one token per 5 s): mint keys once and store them.
> 7. **Never retry "trade then depart" as one unit.** Every ton handled at a berth extends the turnaround lock. Trade once, then retry only `depart` until `turnaround_unlocks_at` has passed.
> 8. **Insure the voyage you actually sail.** A policy is void if the ship sails anywhere but its `dest_port_id`.

---

## 1. Quickstart (verified against a live server)

Requires `bash`, `curl`, `jq` and `uuidgen`. Every route between London and its neighbours (Dover, Calais, Ostend, Dunkirk, Le Havre, Portsmouth, Amsterdam) is coastal water, safe for the starter `hoy`. Economies vary per world, so step 0 picks a good London `manufactures` that one of them `imports`.

```bash
BASE=http://localhost:8080; H='content-type: application/json'
HANDLE=hawkins_bot; PASS='correct horse battery'
post() { curl -s -X "${3:-POST}" "$BASE$1" -H "$H" -H "$A" -H "Idempotency-Key: $(uuidgen)" -d "$2"; }

# 0. Pick a lane in this world: a good London manufactures and a nearby port imports
read GOOD DEST < <(curl -s $BASE/v1/world/catalog | jq -r '(.ports[]|select(.id=="london").manufactures) as $m
  | [.ports[] | select(.id|IN("portsmouth","le_havre","amsterdam","calais","dover","ostend","dunkirk"))
     | .id as $p | .imports[] | select(. as $g | $m|index($g)) | "\(.) \($p)"] | first')
echo "$GOOD -> $DEST"   # e.g. ironwork_tools -> portsmouth

# 1. Register (201, no key), then log in for a player-level key (all scopes, 24 h by default)
curl -s -X POST $BASE/v1/player/register -H "$H" -d "{\"handle\":\"$HANDLE\",\"passphrase\":\"$PASS\"}"
PKEY=$(curl -s -X POST $BASE/v1/auth/login -H "$H" \
  -d "{\"handle\":\"$HANDLE\",\"passphrase\":\"$PASS\",\"label\":\"bootstrap\"}" | jq -r .api_key)

# 2. Found the company (names are unique server-wide) at a coastal Phase-1 port (amsterdam calais dover dunkirk hamburg le_havre london
#    ostend portsmouth): 7,500 Cr + a berthed hoy with 4 cannons and 8 t of stores
A="authorization: Bearer $PKEY"
CO=$(post /v1/company/create '{"name":"Hawkins Maritime","home_port_id":"london","starter_ship_name":"Endeavour"}')
CID=$(echo "$CO" | jq -r .company.id); SHIP=$(echo "$CO" | jq -r .starter_ship_id)

# 3. Company-bound key (needed for every company route), 7 days. Store it: logins are rate-limited.
KEY=$(curl -s -X POST $BASE/v1/auth/login -H "$H" -d "{\"handle\":\"$HANDLE\",\"passphrase\":\"$PASS\",
  \"company_id\":\"$CID\",\"label\":\"main\",\"ttl_seconds\":604800}" | jq -r .api_key)
A="authorization: Bearer $KEY"

# 4. Inspect: the ship, London's book (berthed ship = quay tier = full depth), the route's stores need
curl -s "$BASE/v1/fleet/ship?ship_id=$SHIP" -H "$A" | jq '{status:.ship.status,effective_hold_capacity_tons,stores}'
ASK=$(curl -s "$BASE/v1/market/book?port_id=london&commodity_id=$GOOD" -H "$A" | jq '.books[0].best_ask.price_pence')
curl -s "$BASE/v1/world/route?from=london&to=$DEST&ship_class=hoy" | jq '{total_distance_nm,expected_provisions_tons,safe_provisions_tons}'
# {"total_distance_nm":143,"expected_provisions_tons":0.078431,"safe_provisions_tons":0.10151}  (London -> Portsmouth)

# 5. Buy 10 t into the hold (IOC; you pay the maker's price plus London customs)
post /v1/market/place-order "{\"port_id\":\"london\",\"commodity_id\":\"$GOOD\",\"side\":\"bid\",
  \"time_in_force\":\"ioc\",\"price_pence\":$ASK,\"quantity\":10,\"ship_id\":\"$SHIP\"}" | jq -c '{filled_quantity,total_gross_pence,customs_duty_pence}'
# {"filled_quantity":10,"total_gross_pence":360280,"customs_duty_pence":12070}

# 6. Depart once the turnaround lock (extended by the purchase) has passed; retry only this call
until R=$(post /v1/fleet/depart "{\"ship_id\":\"$SHIP\",\"dest_port_id\":\"$DEST\"}"); \
      [ "$(echo "$R" | jq -r .status)" = sailing ]; do echo "$R" | jq -r .detail; sleep 5; done
echo "$R" | jq -c '{estimated_arrival_at,warnings,berth_dues_pence}'

# 7. Wait for ship_arrived (long-poll, paging forward by id; a bot would hold the SSE stream).
#    10-20 real minutes at 60x.
AFTER=0
while :; do
  EV=$(curl -s "$BASE/v1/event/stream?after_id=$AFTER&event_type=ship_arrived&timeout_ms=30000&limit=500" -H "$A")
  echo "$EV" | jq -e --arg s "$SHIP" 'any(.[]; .payload.ship_id==$s)' >/dev/null 2>&1 && break
  AFTER=$(echo "$EV" | jq -r --arg a "$AFTER" '.[-1]?.id // $a'); sleep 1
done
curl -s "$BASE/v1/fleet/ship?ship_id=$SHIP" -H "$A" | jq -c '.ship|{status,current_port_id}'   # berthed at $DEST

# 8. Sell into the best bid (sellers pay no customs), then check the vault
BID=$(curl -s "$BASE/v1/market/book?port_id=$DEST&commodity_id=$GOOD" -H "$A" | jq '.books[0].best_bid.price_pence')
post /v1/market/place-order "{\"port_id\":\"$DEST\",\"commodity_id\":\"$GOOD\",\"side\":\"ask\",
  \"time_in_force\":\"ioc\",\"price_pence\":$BID,\"quantity\":10,\"ship_id\":\"$SHIP\"}" | jq -c '{filled_quantity,total_gross_pence}'
curl -s $BASE/v1/treasury/vaults -H "$A" | jq -c '.vaults[]|select(.balance_pence!=0)'
```

Notes: the hoy's 40 t hold minus 2 t per cannon and the 8 t of stores leaves 24 t of cargo room. You can't read the destination's book until you have presence there (`403 no_port_presence`); judge it beforehand from the gossip in `GET /v1/world/port?port_id=london`. Selling a good the port doesn't trade is `400 bad_request` ("has no market for"), so check `imports` first. An IOC order drops whatever doesn't fill at `price_pence` or better. A ship arriving at a full port anchors in the roadstead, queued (`ship_arrived.status` = `anchored_roadstead`), and gets `ship_berthed` later.

---

## 2. Core loop for a profitable trader

1. **Bootstrap once.** Load stored keys (`GET /v1/auth/whoami` to check them), `GET /v1/world/clock` (`unlocked_phase`, `calendar.{month,day,season,time_scale}`), `GET /v1/world/catalog`. On first start, page `GET /v1/world/events?include_expired=true&structural=true` for lasting economic shifts so far.
2. **Subscribe** to `GET /v1/event/sse` and persist the last event id. Drive the bot from events; treat REST as the source of truth and resync after a reconnect or `gap`.
3. **Pick a lane.** Look for goods a port extracts or `manufactures` and a nearby port `imports`. Producers sit cheap, importers dear. A margin must beat the importer-side customs (a few %) plus the spread you cross on both books. Neighbouring ports have thin gaps; longer lanes pay more per ton but tie up the ship longer and face more hazards. **Compare profit per game day**, not per ton.
4. **Per ship, a state machine:**
   - `sailing`: wait for `ship_arrived` (`estimated_arrival_at` is in the depart response and refreshed by `ship_leg_completed`).
   - `anchored_roadstead`: `dock` if not queued. Charters and freight can be delivered from here.
   - `berthed`: read the book, sell, buy, deliver, top up the stores to `safe_provisions_tons` for the next route (IOC `provisions` bid with `into_stores: true`), record `turnaround_unlocks_at`.
   - `departing`: sleep to the unlock time, then `depart`. On `409 conflict` re-read and sleep. **Do not trade again.**
5. **Size orders to the book.** NPC ladders re-quote every 6 game hours; between quotes big orders walk the ladder and pay the full impact. Split lots across ports or re-quotes.
6. **Pre-depart:** stores ≥ `safe_provisions_tons`, hull rated for every zone, winter, cash in this port's region (berth dues settle as you leave the berth) and the destination's (customs), insurance `dest_port_id` matches.
7. **Extra income:** charters (Crown and player) pay a premium for cargo **carried in** from another port (compare with the port's NPC bid, §3.7); freight adds a reward for a ship already going that way (§3.8). Idle cash can underwrite insurance (§3.6), lend (§3.13), go on deposit or into another merchant's venture or ship shares; idle intelligence can be sealed and sold (§3.11). Check `GET /v1/world/monopolies` before planning to buy a good from the Crown: under a royal monopoly you buy it from the holder (§3.9).
8. **Grow carefully.** The starter hoy has no fleet upkeep, but every extra hull ton and factor is billed daily. Add hulls only when your lanes fill what you have; get a regional hull (`cutter`, `brigantine`, `fluyt`) before leaving coastal water. A hull can be built (turnkey or from your materials), bought from another player, or commissioned (§3.4); a voyage can be financed by a loan (the Goldsmiths always lend against a ship), a credit-board match or investors' capital in a venture (§3.13). Borrowed money must be repaid: a default costs you the pledge and shows on your public credit record.

---

## 3. Mechanics

Rule everywhere: **your own companies, and companies linked to yours, may deal with each other at fair terms**: player charters, commissions, ship and share sales, loans and the credit board, invoice financing, deposits, ventures and envelopes work between them exactly as between strangers, and the same hard bands apply (ship and share prices, commission price and collateral, loan and deposit rates). Except: a company never deals with itself (`400`/`403`); orders never match between your companies, and the shipyard's turnkey buying passes over your own and linked asks; freight, futures and underwriting between companies of one player are refused (`403`); the Crown's deposit insurance never pays a deposit with a bank of your own; and royal monopolies, the expansion bonus and bankruptcy count your companies together.

### 3.1 Economy and visibility

Every world rolls its economy from a secret seed: each port's market sizes, extraction, consumption and base customs vary around design defaults, and a few ports gain or lose a good. These levels drift slowly through the season, and the world director occasionally announces lasting structural changes (`world_event` with `structural: true`: `production_collapse`, `production_boom`, `import_slump`) and temporary shocks (`supply_boom`, `demand_shortage`, `admiralty_mobilization`, `pirate_outbreak`). **None of the numbers are published, on purpose.** The catalog says *what* a port trades, never *how much*. Learn the rest by watching prices, scouting quays, and reading gossip.

- Prices follow scarcity: near normal stock a good trades near its catalog `base_price_pence`, steeply dearer as stock falls, cheaper in a glut (bounded both ways). A port only stocks goods it extracts, manufactures or imports (others: `400`); all stock `provisions`.
- NPC shipping pulls prices back toward normal, strongly when a source is near, weakly when far. Shocks fade over game days. Workshops stop when any recipe input runs out.
- A region's NPC bid depth and charter pay scale with its Crown treasury, fed by customs, rent and fees paid there.
- Hub mints buy and sell `silver_bullion` at fixed prices with no customs: a physical alternative to remittance fees.

**Visibility tiers** (per port, shown as `visibility` in `/v1/market/book` and `/v1/world/port`):

| Tier | How | What you see |
|---|---|---|
| `none` | nothing there | `403 no_port_presence`; cannot trade |
| `storage` | any warehouse lease | best bid/ask from a once-per-game-day snapshot (check `as_of`) |
| `counting_house` | lease ≥ `counting_house_min_lease_tons` (5% of capacity) | live best bid/ask |
| `quay` | own ship berthed or anchored there, or a Resident Factor | live full depth (`books[].depth {npc_current_stock, bids, asks}`), and in `GET /v1/world/port`: `coffee_house_gossip`, `lloyds_list`, `recent_sailings`, `convoy_notices`; local charters, freight, commissions and ships for sale; port-scoped events |

News travels only by ship. Each kind reaches a quay this way:

- **Coffee House gossip** (`coffee_house_gossip`): per remote port (`subject_port_id`), the `commodities[] {commodity_id, current_stock, best_bid_pence, best_ask_pence, best_player_bid_pence, best_player_bid_quantity, best_player_ask_pence, best_player_ask_quantity}` a crew saw there, with `age_seconds`. The `best_player_*` fields are the best resting order on each side placed by any company (not the NPC ladder) and the tons at that price, `null` when none: anonymous, and your own orders count, so check `GET /v1/market/orders`. Every company's ships record what they see and post it to each board they call at, so it is free but ages. A packet with sealed dispatches posts nothing (§3.11).
- **Sailing notices** (`recent_sailings`, last 24 game hours, plus port-scoped `ship_sailed` / `ship_entered_port` events): every ship leaving or entering, with its name, hull class, owner's name, where it is bound / came from, convoy name and `load_state` (`ballast` <10%, `part_laden`, `laden` >70% of hold). Never cargo, stores or timings.
- **Charter and convoy news**: non-public charters (§3.7) and public forming convoys (`convoy_notices`, §3.10) are live at their own port and reach other quays after 6 game hours plus the sea distance at 5 knots (~1 game day across the Channel, ~6 from the Baltic), as they stood when the news left.
- **Lloyd's List** (`lloyds_list`): recent underwriting results and `policies_open_here` (§3.6).

### 3.2 Orders, customs, escrow

`POST /v1/market/place-order` `{port_id, commodity_id, side: bid|ask, time_in_force: ioc|gtc, price_pence, quantity, ship_id?, into_stores?}`. Fills are at the maker's price in price-time order.

- **IOC with `ship_id`**: goods go straight into or out of that ship's hold; the ship must be berthed there. `into_stores: true` (IOC `provisions` bid with a ship only) fills the crew's stores instead.
- **IOC without a ship** settles against your warehouse at that port. **GTC** must have no ship and rests on the book: a resting bid escrows price plus customs and reserves warehouse space; a resting ask locks the goods. NPC ladders cross resting orders when they re-quote (every 6 game hours); other players cross them at once.
- **Customs is paid only by the buyer**, on top of the trade value. The live `customs_bps` is in the book and the port view.
- Under a royal monopoly only the holder buys from the Crown's asks in that region (§3.9).
- Escrowed money (resting bids, posted charter rewards, freight reward or collateral, commission price or collateral, convoy escort fees, futures margin, insurance premium or collateral, the principal of a loan offer or credit-board offer you made) shows in the `escrow` row of `GET /v1/treasury/vaults` and is not spendable until released.

### 3.3 Ships, berths, stores

`GET /v1/fleet/ship?ship_id=` returns `{ship:{status, current_port_id, turnaround_unlocks_at, dock_queued_at, cannons_count, stores_provisions_units, dispatches_sealed, ...}, hold_capacity_tons, effective_hold_capacity_tons, cargo_used_tons, stores:{provisions_tons, sea_days_remaining}, cargo_manifest, route_legs, voyage}`. `status` is `berthed`, `anchored_roadstead`, `sailing` or `sunk`; `stores_provisions_units` is the raw store (1,000,000 units = 1 t), `stores` the same in tons. `GET /v1/fleet/ships` lists your fleet.

- **Berthing** (on arrival, `POST /v1/fleet/dock {ship_id}`, or promotion from the queue) sets a 30 game-minute turnaround lock. Each ton bought, sold, loaded, unloaded or accepted as freight at a berth adds 1 game minute at hubs, 2 elsewhere. `depart` and `offshore` return `409 conflict` while a berthed ship is locked. A ship in the roadstead can leave at any time. A ship berthed over 6 game hours can be evicted to the roadstead by a docking ship (`ship_evicted`; it is not queued, `dock` again).
- **Berth dues:** a berth costs `berth_dues_per_day_pence` per game day berthed (`GET /v1/world/port`: 10 Cr a day in a quiet port, tripled above 70% occupancy, up to 75 Cr), pro rata with a 6-game-hour minimum per stay, from your vault in the port's region: settled when the ship leaves the berth (`berth_dues_pence` on the offshore and depart results) and daily for ships still berthed. Turn around fast; an idle ship can wait in the roadstead (`POST /v1/fleet/offshore {ship_id}`), which is free. Can't pay: the shortfall is booked as vault debt (`berth_dues_debt_pence`), swept from your other vaults and collected by the bailiff. Ports gain berths as the active fleet grows: `effective_berths` = `base_berths × √(active ships / 40)`, never below `base_berths` (both in the catalog and the port view, with `occupied_berths` and `queued_ships`).
- **Departing:** `POST /v1/fleet/depart {ship_id, dest_port_id, allow_starvation?}` plans the shortest open route; the result has `estimated_arrival_at`, `warnings` and `berth_dues_pence`.
- Spot trading, warehouse load/unload need **berthed**. Charter and freight delivery and buying insurance also work from the roadstead.
- **Stores are not cargo.** `stores.provisions_tons` (fractional tons; `sea_days_remaining` is how long they feed this crew at sea) is what the crew eats; it takes hold space (every ton it starts: 0.3 t takes a whole ton) but can't be sold, delivered or insured. Provisions in `cargo_manifest` are ordinary goods the crew never eats. Fill stores with an `into_stores` bid or `POST /v1/fleet/provision {ship_id, tons, source: cargo|warehouse}` (whole tons); empty them with `POST /v1/fleet/unprovision {ship_id, tons, destination: cargo|warehouse}` (only whole tons the stores hold).
- The crew eats exactly `crew × sailing days / 100` t at sea and half that in port (`crew / 200` t per game day), taken from the stores exactly (a hoy's short hop eats a few hundredths of a ton). The crew needs something aboard at the start of **every** leg; the stores run dry when they reach zero. `depart` checks this and returns `409 insufficient_provisions` with `provisions_shortfall {required_provisions_tons, stores_provisions_tons, buy_provisions_tons, starving_leg_idx}` (`buy_provisions_tons`: the shortfall in whole tons); `allow_starvation: true` overrides it (don't). Convoy departures are not checked.

```json
// POST /v1/fleet/depart {"ship_id":"…","dest_port_id":"dover"} with empty stores -> 409
{"type":"urn:tradewinds:error:insufficient_provisions","title":"Conflict","status":409,"code":"insufficient_provisions",
 "detail":"Ship's stores hold 0.00t of provisions but it needs 0.03t in stores (buy 1t) to reach port fed: …",
 "provisions_shortfall":{"required_provisions_tons":0.032732,"stores_provisions_tons":0.0,"buy_provisions_tons":1,"starving_leg_idx":0}}
```
- Laden ships are slower (up to 20% when full). Each cannon displaces 2 t of hold.
- **Warehouses:** `POST /v1/warehouse/set-lease {port_id, target_leased_tonnage}` (rent daily; you need presence there first: a ship in port or a factor); `POST /v1/warehouse/load-ship` / `unload-ship {ship_id, commodity_id, quantity}`; `GET /v1/warehouse/list`, `GET /v1/warehouse/inventory`.

### 3.4 Shipyard and the ship market

- **Build:** `GET /v1/shipyard/quote?port_id=&ship_class=&build_mode=` prices exactly what `POST /v1/shipyard/build-ship {port_id, name, ship_class, build_mode: byom|turnkey_cash}` charges. `byom` uses your warehouse materials there plus labour. `turnkey_cash` buys each material for you off the port's ask book, cheapest first: other players' asks (paid like any trade) and the NPC ladder, then the NPC stockpile behind it. You pay customs on every fill, and the 15% yard markup only on what came from the NPCs, so a yard where players sell materials builds cheaper. It skips your own and linked companies' asks and any ask over **2.5x** the book's mid. Under a monopoly on a material, a non-holder's turnkey build takes it only from players' asks and is refused if they can't cover it (§3.9).
- **Guns:** new ships have 0 cannons; `POST /v1/shipyard/modify-ship {ship_id, target_cannons_count}` (0..=the class's `max_cannons`; a hoy takes 4) refits them at a yard (150 Cr per gun added). Guns can't be removed while the ship is insured.
- **Rebuild value** (the class's cheapest current turnkey quote at an open yard plus 150 Cr per gun) anchors ship sales, commissions, share prices, insurance and loan appraisals.
- **Buy and sell ships:** `POST /v1/fleet/list-ship {ship_id, price_pence}` offers a ship lying at a port at **50%..=150%** of its rebuild value. It must be free to change hands: empty hold, no convoy or convoy request, no open insurance, no loan lien. `GET /v1/fleet/ship-listings?port_id=` shows what is for sale where you have quay presence (no `port_id`: your own listings). `POST /v1/fleet/buy-ship {listing_id}` (quay presence there) pays the seller from your vault in that region and the ship is yours at once with its berth or roadstead place, stores and guns (not its crew's gossip from other ports); berth dues from then on are yours. The band is re-checked at purchase (`409` if the rebuild value has moved: the seller must relist). `POST /v1/fleet/cancel-ship-listing {listing_id}` withdraws it; a listing lapses if the ship sails, sinks, joins a convoy, changes its guns or has stores taken off.
- **Commissions** (a hull built to order): the buyer posts `POST /v1/contract/create-commission {port_id, ship_class, price_pence, collateral_pence?, deadline_game_hours}`: the price (50%..=150% of the hull's rebuild value) is escrowed from its vault in the yard's region; `collateral_pence` (default 0, at most **25%** of the price) is what the builder must put up; deadline 6..=1440 game hours. The buyer needs no presence; the commission is listed in `contract/list` (`contract_type: "commission"`, `ship_class`) to companies with quay presence at the yard. `cancel-commission {contract_id}` while no one has taken it. A builder with presence at the yard calls `accept-commission {contract_id}` (escrows the collateral), then `deliver-commission {contract_id, name, build_mode}` builds the ship there exactly as `build-ship` would, at the builder's cost (quote first), hands it to the buyer berthed at the yard, and collects the price plus its collateral back. At the deadline an untaken commission is refunded; a taken one not delivered refunds the buyer and forfeits the builder's collateral to the buyer.

### 3.5 Hazards, marques and patrols

- **Each leg** rolls storm and piracy for the zone it ends in; longer legs carry more risk. Storm risk is driven by hull class vs zone class and winter. Piracy is driven by the zone's net piracy (`GET /v1/world/zones`), cut sharply by cannons (in a convoy, every member's guns count), and pirates hunt richer holds more often.
- **Storm:** a hit destroys 25% of every cargo stack and exactly a quarter of the stores (1 t leaves 0.75 t); a sinking loses everything.
- **Pirates:** an interception carries the ship off (hull, cargo and stores; 5–10% of interceptions, fewer the more guns face them) or seizes 20–50% of every cargo stack and of the stores and lets it go.
- **Zone piracy is a crowd-funded tug of war.** `POST /v1/fleet/issue-marque {sea_zone_id, added_piracy_bps, duration_game_hours?}` raises it; `POST /v1/fleet/fund-patrol {sea_zone_id, suppressed_piracy_bps, duration_game_hours?}` lowers it. Each names 50..=1500 bps and a term (default 60 game hours, 5..=1440), is paid from your home-region vault, and costs per bps per game day of the term, at least 100 Cr (`cost_pence` in the response). Contributions from every company stack per zone (each side capped at 5,000 bps; beyond the cap you are still charged) and hit everyone sailing there equally, sponsor included. `GET /v1/world/zones` shows each zone's `base_piracy_bps`, `marque_piracy_bps`, `patrol_suppression_bps`, counts, soonest expiry and `net_piracy_bps`. Sponsors are anonymous: notices and the zone view never name them, and `GET /v1/fleet/marques` / `GET /v1/fleet/patrols` list only your own.
- **Patrols** cost **2 Cr per bps-day** (400 bps for 2.5 days is 2,000 Cr, for 10 days 8,000 Cr), and cheapen insurance for everyone in the zone.
- **Marques are priced from the zone's traffic**: 60% of the prize money a bps-day of marque is expected to earn there after the Admiral's tenth, from player ships' passages over the last 7 game days, never under 0.1 Cr. It counts the marques already in force (corsairs too), which share every prize pool with you, and patrols. So it pays ~1.67x its price back anywhere if traffic holds; a dead zone is cheap but earns nothing. Quote first: `GET /v1/fleet/marque-quote?sea_zone_id=&added_piracy_bps=&duration_game_hours=` (`read`) returns `window_game_days`, `marque_bps_in_force`, `laden_passages`, `laden_passages_per_day`, `avg_cargo_base_value_pence`, `expected_net_prize_per_bps_day_pence`, `price_per_bps_day_pence` (`floor_applied`), `cost_pence` and `expected_net_prize_pence`. `issue-marque` charges exactly that quote, returns it as `pricing`, and the price is fixed for the term.
- **Prize money:** while your marque is in force, every pirate interception in its zone pays you a share: the prize court pays **half the seized cargo's base value**, times the marques' share of the zone's piracy (`marque / (base + marque)`, patrols ignored), split among the marques in force pro rata by bps, less **the Admiral's tenth** (10% of your share). It is paid into your vault in the region you paid from (`banking_region` on the marque); `fleet/marques` shows `prize_earned_pence`, and each payment sends you a private `marque_prize_paid` (marque, zone, `prize_pence`, `admirals_tenth_pence`, goods seized; never whose ship). The quote is an estimate from past traffic: if traffic dries up, you earn less. Victims never learn who sponsored it.

### 3.6 Marine insurance

- **One policy per voyage.** `POST /v1/insurance/create {ship_id, dest_port_id, insured_value_pence, premium_bps}`: ship berthed or in the roadstead, no open policy on it, premium 10..=3000 bps (escrowed). `insured_value_pence` may not exceed hull value + current cargo; above it you get `400 exceeds_insurable_value` with the cap in the body (example below). The hull value is the ship's rebuild value (§3.4), fixed on the policy as `hull_value_pence`; anything above it is the declared cargo (cargo valued at the higher of base price and the port's NPC mid; stores are not insurable). A policy still in port 15 game days after it was written lapses.
- **Underwriters** (players or Lloyd's) take slices: `POST /v1/insurance/underwrite {policy_id, slice_bps}` (multiple of 100, from 500 to what is left uncovered; a remainder under 500 may be taken whole), escrowing `insured_value × slice` as collateral and earning that share of the premium. `covered_bps` on the policy is the total written; status turns `open` → `active` with the first slice. A partly covered policy pays claims pro rata; unwritten premium is refunded at settlement.
- **Bound at departure.** It is void (`cancelled`, no claim ever) if the ship sails anywhere but `dest_port_id`, if consorts Lloyd's priced in don't sail with it (`priced_consorts_absent`), or if the hold draws more pirates than the declared cargo would (`cargo_exceeds_declared`: declare the whole cargo, at least at base value, or load nothing after writing). If you sold or unloaded cargo since insuring, the cover is cut to what's aboard.
- **Payouts:** a **sinking or capture** pays the full collateral (`claimed_loss`); a **storm** pays the lost share of the sum insured, capped at **25% of the declared cargo**; **pirates who let the ship go** pay likewise, capped at the share they seized of the declared cargo (at most half); hull-only cover pays only on a total loss. A partial claim leaves the policy in force. A **convoy rescue** pays as a partial loss capped at 60% of declared cargo. **Arrival** closes it `settled_safe`, releasing collateral to underwriters and refunding unwritten premium, so insure the next leg with a new policy. A **mutiny** closes it `settled_safe` with nothing paid.

```json
// POST /v1/insurance/create {"ship_id":"…","dest_port_id":"portsmouth","insured_value_pence":900000000,"premium_bps":200}
// 400
{"type":"urn:tradewinds:error:exceeds_insurable_value","title":"Bad Request","status":400,
 "detail":"insured_value_pence 900000000 exceeds the ship's insurable value of 2318659 (hull rebuild quote 1958659 plus current cargo)",
 "code":"exceeds_insurable_value",
 "insurable_value":{"requested_pence":900000000,"max_insurable_pence":2318659,"hull_value_pence":1958659}}
```
- **Lloyd's Coffee House Syndicate** (an NPC house) underwrites anywhere, but only looks at policies open about a game hour, every couple of game hours, so wait in port for it. It writes only if `premium_bps ≥ ceil(2.5 × expected loss) + 25` (its **posted price**), at the premium you offered (nothing above the price is refunded). The expected loss is a cautious estimate from public data: route, your class and cannons, each zone's net piracy now (marques, corsairs and patrols included), the harshest season the policy could sail into. It locks **at most 10% of its funds as collateral on one policy and 20% across all ships leaving one sea zone** (about 56,000 / 112,000 Cr in a fresh world, less after heavy claims), so a big policy or a crowded port may only be partly covered (`covered_bps` < 10,000). If your ship is in a forming convoy bound for the same port when it looks, Lloyd's prices in the consorts' rescue chance, and those consorts must then sail with you.
- **Quote before you offer:** `GET /v1/insurance/quote?ship_id=&dest_port_id=&insured_value_pence=` (`read`, your ship in port) returns `hull_value_pence`, `max_insurable_pence`, `lloyds_expected_loss_bps` / `_pence` (an upper bound on the expected claim), `lloyds_premium_bps` / `_pence` (Lloyd's price: offer it and Lloyd's covers what players leave, within its caps), `priced_consort_ship_ids` and `lloyds_writes` (false if the price is over 3,000 bps). It moves with zone piracy, the season and your convoy, so quote just before `insurance/create`, which echoes `lloyds_premium_bps` (null if Lloyd's would not write the voyage) and `above_lloyds_price` (your offer is above it; still charged in full). Lloyd's is a dear backstop: **offer less** to attract player underwriters in the hour before Lloyd's looks and accept that what they leave may stay uncovered; offer the price or more if you need cover for sure.
- **Underwriting pays: read the Lloyd's List.** `GET /v1/insurance/lloyds-list?days=30` (public; `days` 1..=360) shows results this season (`all_time`) and over the last `days` game days (`recent`) for Lloyd's (with its `company_id` and `funds_pence`), for player underwriters as one group and for everyone: `premiums_earned_pence`, `claims_paid_pence`, `net_pence`, `loss_ratio_bps`, `return_on_cover_bps`, policies written / settled safe / claimed loss / voided, plus `collateral_locked_pence` and `open_policies` now. Results count once a policy settles. To pick policies, `GET /v1/insurance/list?status=open` (or `active`; also `origin_port_id`, `dest_port_id`, `ship_id`, `insured_company_id`, `underwriter_company_id`): each policy still open for underwriting carries `lloyds_expected_loss_bps` (an **upper bound** on the claim), `premium_margin_bps` (`premium_bps` minus it: your expected margin per slice, at least this) and `lloyds_min_premium_bps` (Lloyd's posted price). You get first pick: a slice at a positive margin is yours if you take it before Lloyd's looks.

### 3.7 Charters

`contract_type: "charter"`: a request for goods at `origin_port_id` (the delivery port), paying `reward_per_ton_pence`, first come first served until `remaining_quantity` is gone. It names only where to deliver, not where the goods come from.

- **Listing:** `GET /v1/contract/list` (filters `contract_type`, `port_id`, `dest_port_id`, `commodity_id`, `status`; send your company key). Expansion and Admiralty mobilization charters are `is_public` (listed to anyone, even without a key). Others are listed live only with quay presence at the charter port; elsewhere they arrive as **gossip** (§3.1): `stale: true`, with `gossip.news_as_of` / `heard_at_port_id`, and `remaining_quantity` as it was when the news left.
- **Crown sources:** Admiralty expansion charters (§3.15), Governor procurement when a port's input runs critically short, Governor crisis charters from `demand_shortage` events, Royal Navy mobilization charters, and Crown Guild charters that keep a stock of open work. Crown and Governor charters stay open a week (7 game days) longer than their news takes to reach the nearest company home port, clamped to **10–20 game days** (10 in the Channel and North Sea, ~13 at Danzig, 20 in the Caribbean), and are sized to what the regional Crown can afford.
- **Deliver:** `POST /v1/contract/deliver-charter {contract_id, quantity, ship_id}` (or `deliver-charters-batch {deliveries:[...]}`): the ship must be at the charter port (berthed or roadstead), and **only cargo it carried in from another port counts**. Anything bought or loaded at that port since arrival, warehouse stock, and the ship's stores never count. Partial deliveries are fine. Crown pay goes to your vault in that region; each 10 Cr earned adds a point of `crown_prestige` (a score only).
- **Player charters** (`funded_by: "issuer"`, `issuer_company_id` set) are delivered to the same way; they pay from the issuer's escrow, the goods go into its warehouse, and they earn no prestige. **Post one** to have goods brought to you: `POST /v1/contract/post-charter {port_id, commodity_id, quantity, reward_per_ton_pence, duration_game_days?, is_public?, title?}`. You need free leased warehouse space at `port_id` for every ton (reserved) and the whole reward in your vault in that region (escrowed). Term 2–20 game days (default 10); `is_public: false` (default) makes it local news that spreads as gossip. The reward is capped at **10x** the good's base price per ton. At most 10 open at once. `POST /v1/contract/cancel-charter {contract_id}` (or expiry) refunds what is undelivered and frees the space. `charter_delivery_received` tells you who delivered.

### 3.8 Freight

- **Accept** an open listing (listed only at its origin port): `POST /v1/contract/accept-freight {contract_id, ship_id}` (or `accept-freight-batch {items}`). The ship must be berthed at the origin with room; the goods go straight into the hold and your `collateral_pence` is escrowed. The contract is bound to that ship with a `delivery_deadline` (about twice the laden sailing time, plus 2 game days).
- **The cargo is sealed**: it can't be sold, unloaded or delivered to a charter anywhere. Your own goods beside it trade normally.
- **Deliver** with the same ship at the destination (berthed or roadstead): `POST /v1/contract/deliver-freight {contract_id, ship_id}`. You get the reward and your collateral back. If the issuer has no free warehouse space there, delivery is refused (`409`); if the contract then expires while you wait there with the cargo, the issuer is in breach and you are paid, refunded and keep the cargo.
- **Default** (deadline passes): you lose the collateral and the sealed cargo is confiscated.
- **Issue** freight: `POST /v1/contract/create-freight {origin_port_id, dest_port_id, commodity_id, quantity, reward_pence, collateral_pence}` locks your warehouse stock at the origin and escrows the reward; the listing stays open 5 game days.
- NPC **Merchant Adventurers** houses post freight in lots sized to the holds of ships in their region, more listings the more ships are about and the more of them get taken. It pays a little more per ton than trading the goods yourself on that lane, plus distance and danger pay, and needs only the collateral (25% of the cargo's value for lots up to 30 t, 40% above): a steady fill for an empty hold.
- A carrier can borrow against its reward, and an issuer against a carrier's collateral (invoice financing, §3.13.3).

### 3.9 Royal monopolies

The Crown sells, for 5, 10 or 20 game days, the sole right to **buy one good from the Crown merchants (the NPC asks) at every port of one banking region**. While one is in force, only the holder takes the Crown's asks there, and only the holder's resting bids are filled by the Crown's ladder; everyone else (the holder's other companies and linked companies included) must buy from the holder's resting asks or bring the goods in. An IOC buy that only the monopoly kept from filling is refused `409`, naming the holder; a GTC bid just rests. Selling to the Crown is unaffected, and so are provisioning and charters. Provisions and silver bullion are never sold.

- **Who holds what:** `GET /v1/world/monopolies` (public; filters `banking_region`, `commodity_id`, `include_expired=true` for history), plus public `monopoly_granted` / `monopoly_expired` events.
- **Price:** `GET /v1/world/monopoly-quote?banking_region=&commodity_id=&term_game_days=` = a tenth of the Crown's expected sales of the good in the region over the term (its last 7 game days of sales per day, never below 5 t a day at base price per port that trades it): `price_pence`, `expected_daily_sales_pence`, `held_by`, `available` / `unavailable_reason`. Expensive: thousands to tens of thousands of Crowns on a busy good. It only pays if you resell the region's Crown volume to other buyers at a markup (imports from neighbouring regions cap it, roughly 15%); a monopoly on a quiet good, or one where you are the main buyer, is money thrown away.
- **Buy:** `POST /v1/market/buy-monopoly {banking_region, commodity_id, term_game_days, max_price_pence?}` (scope `market_spot`), paid from your vault in that region, never refunded. One holder at a time. No back-to-back renewal: you (and companies linked to yours) can't have the same scope again until 10 game days after your grant ends. At most **2** monopolies in force per player, across all your companies and linked ones (`409` listing those you hold); the quote with your key shows `player_monopolies_held`, `max_monopolies_per_player` and `player_cap_reached`. A holder that goes bankrupt loses its grants.

### 3.10 Convoys

- **Organize:** `POST /v1/fleet/create-convoy {name, flagship_id, dest_port_id, depart_in_game_minutes, admission?, visibility?, min_speed_centiknots?, escort_fee_pence_per_ton?}`. The flagship must be `anchored_roadstead` (`POST /v1/fleet/offshore` first). `depart_in_game_minutes` is game time, clamped to 1 game hour..14 game days. `admission` is `open`, `approval` (default) or `invite_only`; `visibility` `public` (default) or `private`; `min_speed_centiknots` refuses ships that would slow it below that. Organizer tools: `approve-convoy-request`, `reject-convoy-request`, `kick-convoy-member` (`{convoy_id, ship_id}`), `invite-to-convoy {convoy_id, company_id}`. `GET /v1/fleet/convoys` lists convoys you can see.
- **Announce ahead:** a ship in a forming convoy waits in the roadstead (no docking, no sailing alone, its crew eats), so for a sailing days away use `POST /v1/fleet/announce-convoy {name, origin_port_id, dest_port_id, depart_in_game_minutes, admission?, visibility?, min_speed_centiknots?, escort_fee_pence_per_ton?}`: no ship needed, only a presence at the origin; join your own ships (no fee) and others' later. At most 5 announced convoys still forming per company; one nobody joined is cancelled when due.
- **News:** public forming convoys show in each quay's `convoy_notices` (`GET /v1/world/port`): live at the origin, elsewhere after the same delay as charter gossip, as they stood then: organizer, origin, destination, `departs_at`, `admission`, `escort_fee_pence_per_ton`, `escorts` and their `escort_cannons`, `members`.
- **Join:** `POST /v1/fleet/join-convoy {convoy_id, ship_id, as_escort?}` with a ship anchored at the origin; `status` is `joined` or `pending`. `detach-convoy {convoy_id, ship_id}` leaves before departure. Ships in a convoy can't dock or depart alone.
- **Escort fees:** other companies' non-escort ships pay `escort_fee_pence_per_ton × hold_capacity_tons` (at most 1,000 Cr a ton), escrowed on joining and refunded if they don't sail or are lost. Armed ships can join `as_escort: true`, pay nothing, and split the fees by cannon count on arrival.
- **No speed bonus:** a convoy sails at its **slowest member's** speed. Join for the pooled cannons (all members' guns count against piracy, and pirates take one member per interception) and mutual aid, not speed. Each ship still rolls its own storms and eats its own stores; a convoy doesn't make storms rarer.
- **Rescue:** when a storm would sink a member, consorts whose hulls are rated for that zone may save it; it survives with heavy cargo and stores losses (`convoy_rescue`).
- **Salvage:** if a member still sinks, others recover part of its cargo (not sealed freight) and keep a share as their award; the owner's share is delivered into the owner's warehouse at the destination as far as free leased space allows (lease space there before sailing), the rest stays with the rescuer.
- Ships under arrest (§3.13.1) and venture ships (§3.13.5) can't join a convoy.

### 3.11 Intelligence envelopes, packets, sealed dispatches

News only travels by ship (§3.1); envelopes let you sell what has reached a port, sealed.

- **Seal** `POST /v1/envelope/post {port_id, price_pence, categories, report_port_ids?, commodity_ids?, expires_in_game_hours?}` at a port where you have **quay** tier. `categories` from `port_reports` (that port's coffee-house board plus your own crews' reports there, including the port's own quay), `charters` (its own non-public charters live, and others' whose news has reached it) and `sailings` (its last 24 game hours of sailing notices). Narrow with `report_port_ids` and `commodity_ids`. Everything is copied from game data with its original timestamps: you cannot write anything into it. Each section asked for must hold something (`409` otherwise). Default life 72 game hours, at most 240; at most 20 open envelopes.
- **Browse** `GET /v1/envelope/list?port_id=&category=&covers_port_id=` (no key needed): port, generated title (`"Dover + London prices, 2 charters, 1 sailing, 10h old"`), sections and item counts, ports covered, oldest/newest item ages, price, `expires_at`. Never the contents; the seller is shown only if your key's company has quay presence at that port (else `null`).
- **Buy** `POST /v1/envelope/buy {envelope_id}`: you need presence at the envelope's port (storage tier or better: a lease, a ship, or a factor). The price goes from your vault to the seller's in that port's region; the envelope is yours alone and closed. Read it, and see the seller, under `GET /v1/envelope/mine?role=buyer|seller`. Check the ages: old news is cheap news.
- **Withdraw** `POST /v1/envelope/withdraw {envelope_id}` (seller, unsold).
- The **`packet`** (Phase 2, oceanic, 16 kn, 16 t hold, 2 guns) is the fastest hull afloat by far and carries almost no cargo: a courier that gets a port's quay to the next coffee house first.
- **Sealed dispatches** `POST /v1/fleet/seal-dispatches {ship_id, sealed}` (packets only, `can_seal_dispatches` in the catalog; other hulls `400`; the ship shows `dispatches_sealed`): a sealed packet keeps recording quays but posts nothing to the boards it calls at, so its news stays yours to seal into an envelope. `sealed: false` in port posts it to that board at once (at sea: at the next port).

### 3.12 Money and upkeep

- **Regions:** cash is held per banking region (7), each with a `vault` and an `escrow` account (`GET /v1/treasury/vaults`, `GET /v1/treasury/ledger`). Payments at a port come from that port's region vault. Move money with `POST /v1/treasury/remit {from_region, to_region, gross_amount_pence}`; live fees in `GET /v1/treasury/rates`, or carry silver between hubs.
- **Daily bills:** warehouse rent per port (from that region; dearer when the port is congested, and unused leased tons cost triple when the port is over 70% leased), and **sprawl upkeep** from the home vault for coastal and regional hull tonnage above the first 40 t and for each Resident Factor (both grow faster than linearly: `45 Cr × ((tons − 40) / 100)^1.45 + 120 Cr × factors^1.3`), plus a flat **1 Cr per ton of oceanic hull** a day (a barque 220 Cr, an indiaman 450 Cr) that does not raise the rest. `company_upkeep_billed` summarizes each day.
- **Crown wealth levy:** cash sitting idle in your vaults above **500,000 Cr** (all regions together) pays **0.1% of the excess per game day** to the Crown, from your richest vault first (`crown_wealth_levy`; `wealth_levy_pence` in `company_upkeep_billed`). It only ever takes from the excess, never below the threshold. Money working isn't levied: loans out, bank deposits, venture stakes, escrow (orders, offers, collateral) and goods all fall outside it, and a bank's base is net of what it owes its depositors.
- **Resident Factors:** `POST /v1/company/hire-factor {port_id}` (750 Cr once, plus daily upkeep; max 12) gives quay visibility without a ship. `dismiss-factor {port_id}` stops it; `GET /v1/company/factors` lists them.
- **Auto-remit:** `GET /v1/company/settings` → `{auto_remit_for_bills, auto_remit_min_reserve_pence}` (defaults `true`, `0`). When on, a bill its region can't cover is topped up from your other regions (richest first, normal fee, never below the reserve, all-or-nothing; `auto_remittance` event). `PATCH /v1/company/settings` (`account_manage`) changes only the fields sent. Remitting yourself early is cheaper when fees are high.
- **Bailiff:** unpaid rent drains the vault, cancels resting orders, distress-sells warehouse goods at 50% of reference and cuts the lease; unpaid sprawl sweeps other vaults, dismisses all factors and seizes idle ships (largest first, ships pledged to a lender last) down to 40 t of fleet.

### 3.13 Finance

Every loan, deposit and investment is between two companies in one banking region, paid vault to vault, with events to both parties (§4.4). The Goldsmiths are the only NPC lender; NPC houses never borrow.

#### 3.13.1 Loans and the Goldsmiths' Company

- **Offer:** `POST /v1/loan/offer {borrower_company_id, banking_region, principal_pence, daily_rate_bps, term_game_days, recourse?, collateral_kind, ship_id? | port_id+commodity_id+tons? | contract_id?, offer_game_hours?}` offers another company a loan (≥ 100 Cr, 1..=60 game days; `recourse` default `true`). `collateral_kind`: `ship_lien` (`ship_id`, one of the borrower's ships), `warehouse_goods` (`port_id`, `commodity_id`, `tons` of the borrower's free stock, locked), `contract_receivable` (`contract_id`, §3.13.3) or `unsecured` (always with recourse). A non-recourse loan may lend at most the pledge's appraisal (a ship's rebuild value, goods at the local Crown bid). The principal is escrowed from your vault in that region.
- **Rate bounds:** `daily_rate_bps` must lie within **10%..=300% of the Goldsmiths' rate** of 50 bps a day, i.e. **5..=150 bps a game day** (`GET /v1/loan/backstop-quote` shows both bounds).
- **Accept:** the borrower calls `POST /v1/loan/accept {loan_id}` (the principal lands in its vault and the term starts) or `decline {loan_id}`; the lender may `withdraw {loan_id}`; the offer lapses after `offer_game_hours` (default 24, at most 168).
- **Interest** accrues every game day on the outstanding principal, over the term only. `POST /v1/loan/repay {loan_id, amount_pence?}` pays early (interest to date first, then principal) from the loan's region. At maturity what is owed is taken from the borrower's vaults (that region first).
- **Default:** otherwise the loan defaults. A liened ship goes to the lender where it lies, credited at half its rebuild value (if it is at sea, in a convoy, carrying freight or insured, as soon as it can change hands); pledged goods move to the lender's warehouse with their lease space; the rest (with recourse) is a claim taken from the borrower's vaults daily until paid. A non-recourse shortfall is forgiven. From the default until the lender has it or you pay, the ship is **arrested**: it cannot depart or join a convoy (one at sea finishes its voyage and is held where it arrives), and any cargo of yours left aboard is sold to the port at half base price toward the debt.
- **Liens:** a liened ship can still sail before any default, but cannot be listed, sold, pledged again or carry a venture until repaid; if it sinks the lien is lost and the loan stays owed. A listed ship can't be pledged.
- **The Goldsmiths' Company** (one per region, an NPC house) always lends against one of your ships: `GET /v1/loan/backstop-quote?ship_id=&banking_region=` (default your home region) then `POST /v1/loan/borrow-backstop {ship_id, banking_region?, principal_pence, term_game_days}`: at most 40% of the ship's rebuild value (and at most 7,500 Cr a loan), 50 bps a game day (about 16% over 30 days), 1..=30 game days, with recourse. Dear on purpose: a player lender can beat it. A ship it forecloses on is listed for sale (§3.4).
- `GET /v1/loan/list?role=lender|borrower&status=` lists your own loans with `owed_pence`.

#### 3.13.2 The credit board

- `GET /v1/loan/board?banking_region=` lists standing offers and requests in a region.
- **Lenders post** `POST /v1/loan/post-offer {banking_region, available_pence, min_principal_pence?, daily_rate_bps, max_term_game_days, collateral_kind, max_ltv_bps?, recourse?, expires_in_game_hours?}`: escrows `available_pence`, lent in loans of at least `min_principal_pence` (default: all of it); `ship_lien` / `warehouse_goods` offers need `max_ltv_bps` (1..=10,000 of the pledge's appraisal); or `unsecured`.
- **Borrowers post** `POST /v1/loan/post-request {banking_region, principal_pence, max_daily_rate_bps, term_game_days, collateral_kind, ship_id? | port_id+commodity_id+tons?, recourse?, expires_in_game_hours?}` (nothing escrowed; `recourse: false` insists on non-recourse).
- **Matching:** a request and an offer cross automatically when the request's rate reaches the offer's in the same region and collateral kind, and the principal, term, LTV and recourse fit; **the older entry sets the rate**. Or act at the posted rate: `POST /v1/loan/take-offer {offer_id, principal_pence, term_game_days, ship_id? | port_id+commodity_id+tons?}` / `fund-request {request_id}`. `withdraw-board-entry {entry_id}`. Entries lapse after `expires_in_game_hours` (default 72, at most 720). A match is an ordinary loan (§3.13.1). Receivables are not financed on the board.

#### 3.13.3 Invoice financing

A party to an **accepted** freight contract or commission may borrow against what it stands to be paid on it: `POST /v1/loan/offer` with `collateral_kind: "contract_receivable", contract_id` (by direct offer only). The receivable is the carrier's reward or the builder's price, or, for the issuer or buyer, the collateral its carrier or builder forfeits on failure. When the contract pays that party, its lenders are paid first, up to what each is owed, and the borrower gets the rest. If the contract closes without paying, the receivable is lost (with recourse, the loan stays owed). One financing per contract and party.

#### 3.13.4 Banks

- **Judge a bank first:** `GET /v1/bank/list` (or `GET /v1/bank/status?company_id=`) shows every bank's `demand_rate_bps`, `notice_rate_bps`, `notice_game_hours`, `insured`, `deposits_pence`, `reserves_pence` against the Crown's 20% `required_reserve_pence`, `loans_out_pence`, `underwriting_locked_pence`, `lending_headroom_pence` and `overdue_withdrawals_pence`.
- **Deposit** `POST /v1/bank/deposit {bank_company_id, banking_region, amount_pence, notice?}` (at least 10 Cr; `notice: true` for the notice rate and notice period); interest is credited daily. `GET /v1/bank/deposits` lists yours. **Withdraw** `POST /v1/bank/withdraw {deposit_id, amount_pence?}`: a demand deposit is paid at once as far as the bank's cash reaches, the rest owed now; a notice deposit after its notice.
- **Failure:** a bank that leaves a withdrawal unpaid for a game day fails (`bank_failed`). It pays depositors pro rata as its loans come in; what is left goes through its receivership (depositors after secured lenders and futures claims, ahead of unsecured lenders); anything its loans bring in afterwards goes to the written-off depositors pro rata. An **insured** bank's depositors are also paid by the Crown, up to 2,500 Cr per player, capped per bank, on deposits 14+ game days old, and never for a depositor that defaulted on a loan from that bank.
- **Run a bank:** `POST /v1/bank/charter {demand_rate_bps, notice_rate_bps, notice_game_hours, insured}` (10,000 Cr fee to the Crown, and 50,000 Cr of your own funds after it). Rates 0..=50 bps a game day; `notice_game_hours` 1..=720; `insured` costs the bank 1 bps of insured deposits a day. `POST /v1/bank/terms` (same body) changes them for new deposits. Deposits land in your vault: lend and underwrite with them as usual, but a new loan, board offer or underwriting slice is refused unless your vault cash afterwards is still at least 20% of what you owe depositors. `POST /v1/bank/wind-down` stops new business and pays depositors out pro rata as loans come in; once nothing is lent out it closes, or goes into receivership if it cannot pay everyone. An open bank cannot declare bankruptcy, and a company whose failed bank still owes depositors cannot charter again.

#### 3.13.5 Commenda ventures

- **Open:** `POST /v1/venture/open {ship_id, dest_port_id, investor_share_bps, raise_game_hours?}`: your ship lying at the origin, not in a convoy, not liened; investors take 25%..=90% of the profit after the Crown's 2% stamp duty. Capital is raised for `raise_game_hours` (default 24, at most 168) in the origin's region.
- **Invest:** `POST /v1/venture/invest {venture_id, amount_pence}` (at least 10 Cr; anyone, the merchant itself included). `GET /v1/venture/list?port_id=` shows ventures raising at a port; without `port_id`, the ventures you run or hold (`status=` filters).
- **Spend:** the merchant spends the capital only on cargo into that ship at the origin: `POST /v1/venture/buy {venture_id, commodity_id, quantity, limit_price_pence}` (an IOC from your vault, reimbursed from the venture at once, so you need the cash for a moment). The venture's tons can't be sold, unloaded, delivered or put into stores except through the venture.
- **Sail and settle:** the ship may then sail only to the declared destination, alone, before the raise deadline (a venture that never sails is cancelled and its unspent cash returned). There, `POST /v1/venture/sell {venture_id, commodity_id, quantity, limit_price_pence}` and `POST /v1/venture/settle {venture_id}` (automatic a game day after arrival; leftovers are sold into the bids at no less than half the Crown merchants' bid). Profit: investors get their capital plus their share pro rata, you the rest; a loss is shared pro rata; ship lost: only unspent cash comes back. The ship can't sail again before settling.

#### 3.13.6 Ship shares

- A ship is 64ths; its owner holds every 64th nobody else does. Any holder lists: `POST /v1/ship-shares/list {ship_id, sixty_fourths, price_per_64th_pence, banking_region}` (50%..=150% of a 64th of the rebuild value; paid in that region). `POST /v1/ship-shares/buy {listing_id}` (no presence needed; band re-checked), `POST /v1/ship-shares/cancel {listing_id}`; `GET /v1/ship-shares/listings?ship_id=`, `GET /v1/ship-shares/holdings`.
- **Dividends:** every game day the owner pays each outside holder its 64ths of the ship's realised P&L above what was already paid, from the owner's home vault: sales from its hold less cargo bought into it, freight rewards, its berth dues, its merchant's venture shares. Only sales from the hold count (goods unloaded to a warehouse first don't).
- Shares follow the ship to a new owner and are worthless if it sinks.

#### 3.13.7 Credit records

`GET /v1/loan/credit?company_id=` is anyone's public record: `active_loans`, `active_owed_pence`, defaulted debt still open, loans repaid, defaulted and written off (`loan_written_off_pence`), `last_default_at`, open and written-off futures default claims, `lent_outstanding_pence` and `bankrupt_at`. Check it before lending, depositing or investing.

### 3.14 Bankruptcy

`POST /v1/company/declare-bankruptcy` (no body, scope **`infra_manage`**), at most once per player per 24 real hours.

- **Blocked while** any ship is sailing; you have any open freight, commission or player charter on either side, futures, or insurance as insured or underwriter; you are a lender on a loan, loan offer or board offer; you have money on deposit; you have capital in, or are the merchant of, an open venture; or (for a bank) before winding down.
- **Eligible** when either **stranded** (no ships and liquid worth below what a new hoy costs, and below 3,000 Cr) or liquid worth plus the forced-sale value of every hull beyond one hoy < 2,500 Cr. Liquid worth = all vaults + escrow + goods at the local NPC bid.
- **Borrowing never qualifies you:** debt is not subtracted, and the principal of every loan you owe, and of every loan you defaulted on in the last 30 game days, counts as cash you still hold, as do venture capital and ship shares.
- **Creditors, in order:** every loan you owe is called in and secured lenders take their ships and goods, then their shortfall from your cash; then futures counterparties; then (for a bank) its depositors; then unsecured lenders. What can't be paid is written off.
- **Then** everything else is liquidated, your shares in others' ships go to their owners, your monopolies and credit-board requests end, and prestige resets. Unless a futures claim, a loan or a deposit had to be written off you get 2,500 Cr in the home vault and a new hoy `HMS Phoenix`.
- A bankrupt company trades on but **never ranks again this season**; you may found a new company (which can rank) once the 24 hours are over (`company/create` answers `409` until then).

### 3.15 Expansion phases

The world starts at Phase 1 (Channel, North Sea, Baltic, Iberia). Later theatres open when companies jointly complete the Royal Admiralty's **expansion charters** (`metadata.target_phase` set; listed with progress in `GET /v1/world/expansion`). A tier's tonnage (`target_tons`) is `tons_per_company` × active trading companies (`active_trading_companies`), never below `min_tons`: Phase 2 4,000 t per company (at least 10,000 t), Phase 3 1,000 t (at least 2,500 t), Phase 4 900 t (at least 2,250 t). That paces Phase 2 to open about a week into a 90-real-day season, Phase 3 about three weeks in and Phase 4 about forty days in. The world resizes it as companies come and go (`expansion_target_rescaled`); delivered tons always count. The tier completes on **combined** tons across its charters: no single charter is required, and each has its own cap (a full one takes no more). They pay a premium per ton from the Admiralty (not the regional Crown) over the higher of base and the port's NPC bid when posted (the bid counted only up to 1.25x base, so a starved port's own market outbids the charter): 1.3x, or 1.6x (`premium_bps`, `beyond_coastal_water`) where a hoy cannot sail over rated water from any home, e.g. Cadiz silver: worth a regional hull. They stay open 30 (Phase 2), 60 or 90 game days and are then re-posted; one that stalled comes back smaller at better pay, but any rival delivering cancels the escalation, so waiting rarely pays. When a tier completes, a **completion bonus** of 12% of the tier's base value is split among all who delivered to it with diminishing returns: each player's share is in proportion to the **square root** of its tons valued at base rates, counted across all its own and linked companies (and split among them by their own deliveries), so 85.7% / 9.6% / 4.7% of the tons take about 64% / 21% / 15% of the bonus (`expansion_bonus_paid`), and the next phase opens for everyone (`world_phase_unlocked`). Oceanic hulls (`frigate`, `barque`, `packet`) need Phase 2, `indiaman` Phase 3; the most valuable eastern goods come from Phase 3–4 ports. Routing and factor hiring use only unlocked phases.

### 3.16 Futures and NPC houses (brief)

Hub-only physical futures: `POST /v1/future/create {port_id, commodity_id, side, lot_tons, strike_price_pence, matures_in_game_hours?}` (strike within ±25% of the hub's NPC mid, 25% margin each side, maturity 1..=1440 game hours, default 30), `future/accept {futures_id}`, `future/settle`, `GET /v1/future/list`; settled at maturity from the parties' hub warehouses; a defaulter forfeits its margin plus the adverse move, and what it can't pay is a claim on its record. NPC houses (Lloyd's, the Merchant Adventurers, the Goldsmiths) obey the same rules, use only public information, answer slowly (only listings at least a game hour old) so players get first pick, and price poorly on purpose: any player can beat them.

### 3.17 Seasons, leaderboard, hall of fame

- **Seasons** run a fixed **90 real days**. The operators announce the end date in advance: `GET /v1/world/clock` → `season_planned_end_at` (`null` until announced), plus a `server_announcement` event. They end the season by hand on that date (never automatically): the world pauses, final standings are archived, then everything except player accounts is reset for the next season.
- **Net worth:** cash and escrow in every region (debt negative) + goods you own (warehouses and holds, less freight you carry for others) at catalog base prices + hulls afloat at their build value (each outside holder's 64ths count for the holder, not the owner) − what you owe on loans (principal and interest) + what you are owed on active loans you made + your bank deposits (a bank's deposits count against it) + your capital in open ventures (a venture's cargo counts for its investors, not the merchant). Borrowing never lifts you up the board. The same figure for the live board and the final archive.
- **You rank, not your companies:** each player is ranked once, by their best company. A company that went bankrupt cannot rank.
- **`GET /v1/world/leaderboard`** (public): top 20 `{rank, company_name, home_port_id, net_worth_pence, titles}`, recomputed **every real hour** (`refreshed_at`, `next_refresh_at`), never live. Send a company key to also get `you: {rank, company_name, net_worth_pence, is_calling_company}`, your player's rank even outside the top 20. No handles, ids or sponsorships are shown.
- **`GET /v1/world/hall-of-fame`**: every ended season's top 10 players. The top 3 earn a cosmetic title that shows in later seasons on their flagship company (its leaderboard entry and `GET /v1/world/company?name=`, the public profile: name, home port, founding date, top-20 rank, titles): `Season <n> Champion` (1st), `Season <n> Master Mariner` (2nd, 3rd). Titles survive the reset and have no gameplay effect.

---

## 4. Reference

### 4.1 Keys, scopes and endpoints

- `POST /v1/player/register {handle (1–64), passphrase (8–128)}` → `201 {player}`, no key. `GET /v1/player/profile`.
- `POST /v1/auth/login {handle, passphrase, company_id?, label?, scopes?, ttl_seconds?}` → `201 {key, api_key}`; defaults: all scopes, 24 h. The plaintext `api_key` (`tw_live_…`) is shown once.
- `POST /v1/auth/create-key {label, scopes, company_id?, ttl_seconds?}` with either `handle`+`passphrase` (no TTL = never expires) or a Bearer key holding `account_manage` (sub-key gets at most the caller's scopes and lifetime). `ttl_seconds` 60..=31,536,000.
- `GET /v1/auth/whoami`; `GET /v1/auth/keys` lists your keys; `POST /v1/auth/revoke {key_id?}` (alias `revoke-key`; no `key_id`: the calling key); `POST /v1/auth/revoke-all {company_id?, keep_current_key?}`; `POST /v1/auth/change-passphrase {handle, current_passphrase, new_passphrase, revoke_all_keys?}` revokes **every key** unless `revoke_all_keys: false`.
- **Company routes need a company-bound key** (`company_id` set); a player-level key gets `403 company_key_required`. A player may own 5 companies. `POST /v1/company/create {name, home_port_id, starter_ship_name?}`; `GET /v1/company/profile`.

Every route, by the scope it needs (all under `/v1`):

| Scope | Routes |
|---|---|
| public (no key) | `POST player/register`, `auth/login`, `auth/change-passphrase` (passphrase in body); `GET world/clock`, `world/catalog`, `world/ports`, `world/port` (your tier, gossip and notices if a company key is sent), `world/route`, `world/zones`, `world/events`, `world/expansion`, `world/leaderboard`, `world/hall-of-fame`, `world/company`, `world/monopolies`, `world/monopoly-quote` (your cap if a key is sent), `treasury/rates`, `contract/list` (public charters only without a key), `future/list`, `insurance/list`, `insurance/lloyds-list`, `envelope/list` |
| `read` | `GET auth/whoami`, `auth/keys`, `player/profile`, `company/profile`, `company/settings`, `company/factors`, `treasury/vaults`, `treasury/ledger`, `fleet/ships`, `fleet/ship`, `fleet/convoys`, `fleet/marques`, `fleet/marque-quote`, `fleet/patrols`, `fleet/ship-listings`, `shipyard/quote`, `warehouse/list`, `warehouse/inventory`, `market/book`, `market/orders`, `market/fills`, `insurance/quote`, `loan/list`, `loan/credit`, `loan/backstop-quote`, `loan/board`, `bank/list`, `bank/status`, `bank/deposits`, `venture/list`, `ship-shares/listings`, `ship-shares/holdings`, `envelope/mine`, `event/sse`, `event/stream`; `POST auth/revoke` (own key) |
| `fleet_navigate` | `POST fleet/dock`, `fleet/offshore`, `fleet/depart`, `fleet/seal-dispatches`, `fleet/create-convoy`, `fleet/announce-convoy`, `fleet/join-convoy`, `fleet/detach-convoy`, `fleet/approve-convoy-request`, `fleet/reject-convoy-request`, `fleet/kick-convoy-member`, `fleet/invite-to-convoy`, `fleet/issue-marque`, `fleet/fund-patrol`, `shipyard/modify-ship` |
| `fleet_cargo` | `POST fleet/provision`, `fleet/unprovision`, `warehouse/load-ship`, `warehouse/unload-ship` |
| `market_spot` | `POST market/place-order`, `market/place-orders-batch`, `market/cancel-order`, `market/cancel-orders-batch`, `market/buy-monopoly`, `venture/buy`, `venture/sell` |
| `market_derivatives` | `POST contract/deliver-charter`, `contract/deliver-charters-batch`, `contract/post-charter`, `contract/cancel-charter`, `contract/create-freight`, `contract/accept-freight`, `contract/accept-freight-batch`, `contract/deliver-freight`, `contract/create-commission`, `contract/accept-commission`, `contract/cancel-commission`, `contract/deliver-commission`, `future/create`, `future/create-batch`, `future/accept`, `future/accept-batch`, `future/settle`, `insurance/create`, `insurance/underwrite`, `insurance/underwrite-batch`, `envelope/post`, `envelope/buy`, `envelope/withdraw`, `venture/open`, `venture/invest`, `venture/settle` |
| `infra_manage` | `POST warehouse/set-lease`, `shipyard/build-ship`, `fleet/list-ship`, `fleet/cancel-ship-listing`, `fleet/buy-ship`, `ship-shares/list`, `ship-shares/buy`, `ship-shares/cancel`, `company/hire-factor`, `company/dismiss-factor`, `company/declare-bankruptcy` |
| `treasury_remit` | `POST treasury/remit`, `loan/offer`, `loan/accept`, `loan/decline`, `loan/withdraw`, `loan/repay`, `loan/borrow-backstop`, `loan/post-offer`, `loan/post-request`, `loan/withdraw-board-entry`, `loan/take-offer`, `loan/fund-request`, `bank/charter`, `bank/terms`, `bank/deposit`, `bank/withdraw`, `bank/wind-down` |
| `account_manage` | `POST company/create` (player-level key is fine), `PATCH company/settings`, `POST auth/create-key` (Bearer mode), `auth/revoke-all`, `auth/revoke` with another `key_id` |

Batches (all-or-nothing; on failure nothing applies and the error has `batch_index`): `place-orders-batch {orders}`, `deliver-charters-batch {deliveries}`, `accept-freight-batch {items}`, `future/create-batch {orders}`, `future/accept-batch {futures_ids}`, `insurance/underwrite-batch {items}` take 1–25 items; `cancel-orders-batch {order_ids}` 1–50.

List endpoints page with `cursor` (last `id`) and `limit` (usually default 50, max 200).

### 4.2 Errors

Errors are `application/problem+json`: `{type, title, status, detail, code}` plus `batch_index`, `provisions_shortfall` or `insurable_value` where relevant. Branch on `code`; read numbers (shortfalls, unlock times) from `detail`.

| Code | Status | Meaning |
|---|---|---|
| `missing_authorization_header`, `invalid_api_key`, `revoked_api_key`, `expired_api_key`, `unauthorized` | 401 | bad or missing key |
| `company_key_required`, `missing_scope`, `forbidden` | 403 | wrong key type/scope, or a deal your companies may not make with each other (freight, futures, underwriting, or your own charter) |
| `account_suspended` | 403 | your account is suspended by the operators: login and every key refused; contact them |
| `company_frozen` | 403 | the operators froze this company: its writes are refused, reads still work; contact them |
| `no_port_presence` | 403 | no lease, ship or factor at that port |
| `bad_request`, `insufficient_funds`, `insufficient_inventory`, `not_starter_home_port`, `no_shipyard_at_port`, `same_account_transfer`, `invalid_idempotency_key` | 400 | validation, shortfalls, hold/space limits |
| `exceeds_insurable_value` | 400 | sum insured above hull rebuild quote + cargo; body carries `insurable_value {requested_pence, max_insurable_pence, hull_value_pence}` |
| `not_found`, `ship_not_found`, `vault_not_found` | 404 | |
| `conflict` | 409 | turnaround lock, wrong port, convoy state, closed contract, refused tender, sealed or venture cargo, royal monopoly, arrested ship, a cap reached |
| `ship_not_berthed`, `ship_not_at_port`, `insufficient_provisions`, `escrow_not_found`, `escrow_exceeded`, `idempotency_request_in_flight` | 409 | |
| `events_expired` | 410 | long-poll cursor older than retention |
| `payload_too_large` | 413 | |
| `idempotency_key_reused` | 422 | same key, different request |
| `rate_limit_exceeded`, `too_many_streams` | 429 | honour `Retry-After` |
| `rate_limit_unavailable` | 503 | the limiter's database was unreachable; retry shortly |
| `internal_error` | 500 | retry with the same Idempotency-Key |
| `world_paused` | 503 | the operators paused the world: game time stands still, nothing sails or bills, only reads (and `/v1/auth/*`) are served. `GET /v1/world/clock` shows `paused: true`; retry later, nothing is lost |

Malformed JSON or an unknown enum/id in a body or query (e.g. a misspelled `commodity_id`) is rejected before the handler with a plain-text 4xx, not problem+json.

### 4.3 Rate limits and idempotency

Token buckets per client IP and, when a Bearer key is sent, per key: a request spends a token from each. IP buckets are 5× the sizes below, except `auth_strict`, which is per IP only at the listed size (one shared bucket for everyone behind your address). The buckets are shared by every server instance, so the limits are the same whichever instance answers. Every response carries `x-ratelimit-bucket`, `-limit`, `-remaining`, `-reset`; a `429 rate_limit_exceeded` adds `Retry-After` (seconds).

| Bucket | Applies to | Burst | Refill/s |
|---|---|---|---|
| `auth_strict` | `POST player/register`, `auth/login`, `auth/create-key`, `auth/change-passphrase` | 20 | 0.2 |
| `read` | GET/HEAD except `/v1/event/*` | 2,000 | 100 |
| `write` | other POST/PATCH | 1,000 | 50 |
| `batch` | paths ending `-batch` | 300 | 10 |
| `stream` | `/v1/event/*` | 200 | 10 |

`Idempotency-Key` (1–255 chars) on any POST/PATCH with a Bearer key: kept 24 h per player, fingerprinted by method, path, company and body. Same key + same request replays the stored response with `Idempotency-Replayed: true`; same key + different request is `422 idempotency_key_reused`; a request still running is `409 idempotency_request_in_flight`. Only 5xx releases a key.

### 4.4 Events

Each event is `{id, event_type, port_id, sea_zone_id, company_id, payload, timestamp}`. Events with `company_id` go only to that company; port-scoped events (`port_id`, no company) only to companies at quay tier there; the rest are public. Events commit with the change they report. Your own synchronous calls (orders, dock, leases, …) are not echoed, except voyage starts (`ship_departed`), the money they move (`tax_and_fee_charged`) and two-party steps (contracts, loans, deposits, sales), which go to both parties.

- **SSE** `GET /v1/event/sse?event_type=&after_id=`: frames `id:`, `event:`, `data:`; keep-alives every 15 s. Without a cursor only new events are sent; `after_id=0` replays the retained log first. **Resume** with the `Last-Event-ID` header (or `after_id`): everything visible since is replayed from the 7-day log, then live, with no gaps or duplicates. An unknown or expired id yields a `gap` event first: resync over REST. A revoked or expired key ends the stream with `auth_revoked`/`auth_expired`. Max 5 streams per company (`429 too_many_streams`).
- **Long-poll** `GET /v1/event/stream?after_id=&timeout_ms=&limit=&event_type=` returns a JSON array (`timeout_ms` ≤ 30,000, default 5,000; `limit` 1–500, default 50). Without `after_id` it returns only events logged after the request; `after_id=0` starts at the oldest retained event. Page forward with the last id. `410 events_expired`: resync over REST, then poll again.
- World history beyond 7 days: `GET /v1/world/events?include_expired=true&structural=&event_type=&port_id=&since=&cursor=&limit=`.

| Group | event_type (who gets it) |
|---|---|
| Ship | `ship_departed`, `ship_leg_completed` (refreshed `estimated_arrival_at`), `ship_provisions_exhausted`, `ship_arrived` (`status`, `queue_position`), `ship_berthed`, `ship_evicted`, `voyage_hazard` (`hazard`, `sunk`, `captured`, `cargo_loss_pct`), `ship_mutinied` (company); `ship_sailed`, `ship_entered_port` (port-scoped notices) |
| Convoy | `convoy_formed` (public unless private), `convoy_invited`, `convoy_join_requested`, `convoy_request_approved`/`_rejected`/`_withdrawn`/`_lapsed`, `convoy_member_joined`/`_detached`/`_kicked`/`_left_behind`, `convoy_departed`, `convoy_leg_completed`, `convoy_arrived`, `convoy_cancelled`, `convoy_disbanded`, `convoy_escort_fees_settled`, `convoy_rescue`, `convoy_salvage`, `convoy_salvage_delivered` (parties) |
| Market | `order_filled` (port-scoped, anonymous), `maker_order_filled`, `order_cancelled` (bailiff) (company) |
| Monopolies | `monopoly_granted`, `monopoly_expired` (public) |
| Charters, expansion | `charter_posted`, `charter_delivered`, `charter_expired`, `charter_cancelled` (public for public charters, else port-scoped to the charter port); `charter_delivery_received` (player charter issuer); `expansion_target_rescaled`, `world_phase_unlocked` (public); `expansion_bonus_paid` (company) |
| Freight | `freight_listed` (port-scoped to the origin); `freight_accepted`, `freight_delivery_refused`, `freight_delivered`, `freight_issuer_breach`, `freight_defaulted` (issuer + carrier); `freight_expired` (issuer) |
| Commissions, ship sales | `commission_listed` (port-scoped to the yard); `commission_accepted`, `commission_delivered`, `commission_defaulted` (buyer + builder); `commission_expired` (buyer); `ship_listed` (port-scoped); `ship_sold` (seller + buyer) |
| Envelopes | `envelope_sold` (seller), `envelope_bought` (buyer) |
| Futures | `futures_listed` (public); `futures_accepted`, `futures_settled`, `futures_defaulted`, `futures_claim_paid`, `futures_claim_written_off` (parties); `futures_expired` (creator) |
| Insurance | `insurance_policy_listed` (public); `insurance_underwritten`, `insurance_cover_reduced`, `insurance_claim_paid`, `insurance_policy_closed` (`settled_safe`/`claimed_loss`/`cancelled`, with `void.reason` when voided) (insured + underwriters) |
| Loans | `loan_board_offer_posted`, `loan_request_posted` (public); `loan_offered`, `loan_offer_closed`, `loan_disbursed`, `loan_repayment`, `loan_defaulted`, `loan_collateral_seized`, `loan_written_off` (lender + borrower; payload: the loan as in `loan/list`) |
| Banks | `bank_chartered`, `bank_winding_down`, `bank_failed`, `bank_closed` (public); `bank_deposit_made`, `bank_withdrawal`, `bank_deposit_written_off` (depositor + bank) |
| Ventures, ship shares | `venture_opened` (port-scoped to the origin); `venture_investment`, `venture_settled` (investors + merchant); `ship_shares_listed` (public); `ship_shares_sold` (seller, buyer, owner) |
| Money | `company_upkeep_billed`, `auto_remittance`, `tax_and_fee_charged`, `crown_bailiff_warehouse_seizure`, `crown_bailiff_upkeep_seizure`, `company_bankruptcy_reset` (company) |
| World | `world_event` (shocks, or `structural: true` lasting shifts), `letter_of_marque_issued`, `naval_patrol_funded` (public, never naming the sponsor); `marque_prize_paid` (sponsor only) |
| Server | `server_announcement` `{message, severity}` (`info`/`warning`/`critical`) from the operators: maintenance, pauses, season ends (public) |

### 4.5 What happens on its own

All in game time unless marked real.

| When | What |
|---|---|
| Every 6 game hours, per port | production and consumption, NPC ladders re-quote (crossing resting orders) |
| Every 2 game hours | NPC houses act: Lloyd's underwrites, Merchant Adventurers take futures and post freight; only on listings at least 1 game hour old |
| Every 10 game hours | the world director: shocks, structural news, Crown charters to keep at least 10 open |
| Every game day | rent, sprawl upkeep and berth dues (with auto-remit and the bailiff), crews in port eat, storage-tier snapshots, loan interest and default collection, bank interest, ship-share dividends |
| On posting | credit-board entries are matched |
| At each deadline | offers, listings, envelopes and board entries lapse; contracts, futures, loans and monopolies settle or expire; policies lapse 15 game days after writing; ventures settle a game day after arrival |
| Every real hour | the leaderboard |
