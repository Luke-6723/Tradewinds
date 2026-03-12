# API Endpoint Suggestions

These are endpoint additions or changes that would meaningfully reduce request volume and improve autopilot performance. Each section describes the current workaround and the ideal API shape.

---

## 1. `GET /trade/trader-positions` — support no `port_id`

**Current behaviour:** Requires `port_id`. Returns 422 if omitted.  
**Workaround:** We call this endpoint once per port in parallel — one HTTP request per port just to build a map of which goods NPC traders stock where.

```
# Current: N requests (one per port)
GET /trade/trader-positions?port_id=port_amsterdam
GET /trade/trader-positions?port_id=port_london
GET /trade/trader-positions?port_id=port_hamburg
...
```

**Suggestion:** Allow omitting `port_id` to return all trader positions across all ports in one call, which is what the spec already implies (`port_id` listed as optional).

```
# Desired: 1 request
GET /trade/trader-positions
→ [ { port_id, good_id, stock, ... }, ... ]  # all ports
```

**Impact:** Reduces per-cycle overhead from N requests to 1. Currently the single biggest request spike on each cycle.

---

## 2. `GET /market/orders` — bulk query across multiple ports/goods

**Current behaviour:** Requires exactly one `port_id`, one `good_id`, and one `side`. Returns 422 if any are omitted.  
**Workaround:** We fire one request per (destination port × good × side) combination to find buy orders — easily 20–40 requests per ship per cycle.

```
# Current: paths × goods requests (e.g. 8 × 5 = 40)
GET /market/orders?port_id=london&good_id=grain&side=buy
GET /market/orders?port_id=london&good_id=cloth&side=buy
GET /market/orders?port_id=hamburg&good_id=grain&side=buy
...
```

**Suggestion A — multi-value params:**
```
GET /market/orders?port_id[]=london&port_id[]=hamburg&good_id[]=grain&good_id[]=cloth&side=buy
→ [ { port_id, good_id, ... }, ... ]
```

**Suggestion B — omit filters entirely to get all open orders:**
```
GET /market/orders?side=buy&status=open
→ all open buy orders across all ports
```

**Impact:** Collapses 20–40 requests into 1. This is the highest-volume endpoint in the autopilot cycle.

---

## 3. `POST /trade/quote` — batch quote request

**Current behaviour:** One quote per request (one port + one good + quantity + action).  
**Workaround:** We fire up to 24 parallel `POST /trade/quote` requests (6 destination ports × 4 goods) to estimate NPC sell prices at destination ports.

```
# Current: up to 24 requests
POST /trade/quote  { port_id: "london",  good_id: "grain", action: "sell", quantity: 50 }
POST /trade/quote  { port_id: "london",  good_id: "cloth", action: "sell", quantity: 50 }
POST /trade/quote  { port_id: "hamburg", good_id: "grain", action: "sell", quantity: 50 }
...
```

**Suggestion:**
```
POST /trade/quotes/batch
Body: [
  { port_id: "london",  good_id: "grain", action: "sell", quantity: 50 },
  { port_id: "london",  good_id: "cloth", action: "sell", quantity: 50 },
  { port_id: "hamburg", good_id: "grain", action: "sell", quantity: 50 }
]
→ [ { token, quote: { unit_price, ... } }, ... ]
```

**Impact:** Collapses 24 requests into 1. These quotes are currently the main reason we hit the rate limit — each autopilot cycle for a single ship can fire ~50 requests total.

---

## 4. `GET /market/blended-price` — returns 0 on empty markets

**Current behaviour:** Returns `{ blended_price: 0 }` (or fails) when no market orders exist at a port. This made it useless as a price signal in low-activity markets.  
**Why it matters:** We originally used this endpoint to estimate NPC sell prices. It silently returned zero, making the autopilot think there were no opportunities. We replaced it with real `POST /trade/quote` calls but those cost 24 requests per cycle (see #3 above).

**Suggestion:** Add an `npc_buy_price` field alongside `blended_price` that reflects what the NPC at that port would actually pay, independently of market order activity:

```
GET /market/blended-price?port_id=london&good_id=grain
→ {
    blended_price: 142,   # existing: average of market orders (0 if no orders)
    npc_buy_price: 128,   # new: what the NPC would currently pay (always present if NPC trades this good here)
    npc_sell_price: 98    # new: what the NPC would sell for (always present if NPC trades this good here)
  }
```

**Alternative:** A dedicated `GET /trade/npc-prices?port_id=london` that returns all NPC buy/sell prices at a port in one call, without needing to create quote tokens.

**Impact:** Single request per port replaces 4+ quote requests. Combined with suggestion #1 (global trader positions), a full price-discovery scan would drop from ~50 requests to ~2.

---

## 5. `GET /world/routes` — filter by reachability

**Current behaviour:** `GET /world/routes` returns all routes in the game. `from_id` filters to routes from one port.  
**Workaround:** We fetch all routes once and do BFS in JS to find multi-hop paths up to 2 hops deep.

**Suggestion:** Add `max_hops` parameter so the server can return the reachable port set directly:
```
GET /world/routes?from_id=amsterdam&max_hops=2
→ all routes reachable within 2 hops of Amsterdam, including intermediate ports
```

Or a dedicated reachability endpoint:
```
GET /world/reachable?from_id=amsterdam&max_hops=2
→ [ { port_id, via_port_id, total_distance, route_ids: [...] }, ... ]
```

**Impact:** Minor — routes are already cached per-cycle with one request. Mainly useful for server-side pathfinding optimisation.

---

## Summary Table

| Endpoint | Current requests/cycle | With suggestion |
|---|---|---|
| `GET /trade/trader-positions` | N (1 per port, ~8–12) | **1** |
| `GET /market/orders` | paths × goods (~24–40) | **1** |
| `POST /trade/quote` (NPC price probe) | paths × goods (~24) | **1** (batch) or **0** (blended-price improvement) |
| `POST /trade/quote` (buy confirmation, top 5) | up to 5 | up to 5 (unchanged) |
| World/fleet/ship-types | 5 | 5 (unchanged) |
| **Total** | **~65–90 per cycle** | **~10–12 per cycle** |

The three highest-impact changes in order: **#3** (batch quotes), **#2** (bulk order query), **#1** (global trader positions).
