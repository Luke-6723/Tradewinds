# Tradewinds

A dashboard and trading bot for [Tradewinds](https://tradewinds.kibb.io/), the headless Age of Sail trading game played over an HTTP API. Sign in, found or pick a company, watch your ships, trade at port order books, and let the fleet autopilot run your ships, pick lanes and buy more ships for you.

Talks to `https://tradewinds.kibb.io/v1` (game guide: `/skill.md`, spec: [docs/kibb-openapi.json](docs/kibb-openapi.json)).

## Tech Stack

- **Next.js 15** with React 19 and TypeScript
- **Tailwind CSS 4** for styling
- **Base UI** for unstyled, accessible components
- **pnpm** as the package manager

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), register or sign in, then found or pick a company. That's the whole setup: no database, no env vars.

- Your passphrase goes straight to kibb.io and is never stored. Sign-in gets a 90-day player key, kept in an httpOnly cookie.
- Picking a company mints a company-bound API key, saved server-side in `.kibb/store.json` (gitignored) so the autopilot can trade while no browser is open.
- Logins are rate limited (12 a minute), so don't hammer the sign-in form.

| Variable | Description | Default |
|---|---|---|
| `KIBB_API_URL` | Game API base URL | `https://tradewinds.kibb.io` |
| `KIBB_STORE_DIR` | Where keys and autopilot settings are kept | `.kibb/` |
| `TOPSTATS_API_KEY` | TopStats token for naming new ships after Discord bots | bundled names |
| `COOKIE_SECURE` | Force the session cookies' `Secure` flag (`true`/`false`) | on when the request came over HTTPS |

## Fleet autopilot

Runs inside the Next.js server; start and stop it from the dashboard. It puts every ship under its own agent and keeps them busy:

- **Lanes.** A lane is one leg of work: sail to a source, load, sail to a destination. Three kinds: **charter** (goods for charters there, live ones and gossiped ones, counted at the chance they're still open), **market** (goods sold to the destination's buyers at the last bid seen there, marked down for its age), and **freight** (Merchant Adventurers lots at the ship's own port). Spare hold and cash are filled with other goods the source sells that the destination wants, and freight lots for the same destination. Costs: the ask with price impact, customs, the remittance fee, and the cargo pirates are expected to take (live zone piracy, net of marques, patrols and the ship's guns). Lanes are ranked by profit per hour over the leg plus the best leg visible from the destination, so a lane ending where a paid return cargo waits beats a dead end. Loads are sized to the cash the fleet can spend; reservations spread ships across charters, sources, buyers and freight.
- **Phase bonus.** Expansion charters also earn a share of the tier's completion bonus (12% of the tier's base value, split by base value delivered), so a ton of cannons is worth far more than a ton of provisions. That expected share, discounted by a setting (75% by default), counts in lane choice and buy prices. The dashboard shows each company's share of the bonus so far.
- **Hold space.** Each gun takes 2 t of hold. With guns on "auto", a ship calling at a shipyard is refitted to the count that earns most on its lane, weighing cargo room against the cargo pirates are expected to take there. In phase-1 waters that is usually none. Surplus stores above what the voyage needs are moved out and sold when the hold is what limits a load.
- **Events.** It long-polls the company's event log: a ship's agent wakes the moment it arrives, is berthed from the queue, is evicted or hit by a hazard, and a posted, filled or expired charter refreshes the world within seconds so idle ships re-plan at once. Timers remain the fallback if the feed drops.
- **Sailing.** Buys up to the charter's break-even price, keeps stores at the route's safe figure, refuses water the hull isn't rated for (lane *and* sea-zone class), delivers from the roadstead when the per-ton berth lock would cost more than waiting out the base lock (several charters in one batch call), and times everything on the server's clock.
- **Freight.** Picks up Merchant Adventurers freight on legs it sails anyway when the reward beats the berth time it costs.
- **Cash.** Buying is paid from the port's banking region; it remits from other regions on demand and always keeps the reserve in the home region. A ship waiting for cash tries again as soon as another delivery pays.
- **Buying ships.** Whenever a ship calls at a shipyard it quotes every allowed class, scores each by payback hours on its best lane net of the extra fleet upkeep, builds the quickest payback within your limit (unarmed unless guns are on "full"). New ships are named after random Discord bots from the [TopStats](https://topstats.gg) API (set `TOPSTATS_API_KEY`), or a bundled list without a key.

Settings (cash reserve, minimum margin, max ships, max payback, allowed classes, guns, phase-bonus weight, freight) apply live. The panel also shows where each ship's time goes (laden, empty at sea, in port, idle), its Cr/hour, and each finished trip's planner estimate against what it made. The home-region reserve never drops below 1.5 game days of fleet upkeep, whatever the setting, and every other region keeps 200 Cr for dues and stores. The enabled flag persists, so a running autopilot resumes when the server restarts. A lease file in `.kibb/` stops a second process (another server or the CLI) from running the same company. Don't give manual orders to ships while it runs.

To run it without the dashboard (e.g. on a server):

```bash
pnpm exec tsx --env-file=.env.local src/workers/kibb-fleet.ts
```

with `KIBB_API_KEY` (a company-bound key) in `.env.local`. See the header of [src/workers/kibb-fleet.ts](src/workers/kibb-fleet.ts) for its settings.

## Pages

Every page works on a phone: below 1024 px the sidebar becomes a drawer behind the header's menu button, panels stack, filters wrap and wide tables scroll sideways.

| Route | Description |
|---|---|
| `/login`, `/register` | Player sign-in and registration |
| `/companies` | Pick or found a company |
| `/dashboard` | Cash, fleet, phase-2 progress, leaderboard; fleet autopilot controls, per-ship lanes, purchases and log; ships, vaults, charters |
| `/map` | Live map: ships placed along their routes, sea lanes, ports, piracy per sea zone |
| `/events` | Live company event feed (long poll) and the world events history |
| `/fleet` | All ships; shipyard quotes and builds (turnkey or own materials), names from TopStats |
| `/fleet/[shipId]` | Ship detail: dock/roadstead, depart with route and stores check, stores in/out, guns, warehouse load/unload, charters and freight here, insurance, convoys |
| `/convoys` | Convoys: organise, join (as escort), leave; approve, reject, kick, invite |
| `/market` | Order books; IOC or GTC orders (ship or warehouse), resting orders and cancels, fills, batch orders |
| `/contracts` | Charters (deliver, batch deliver), freight (accept, batch accept, deliver, issue your own) |
| `/warehouses` | Leases, inventories, load and unload ships |
| `/treasury` | Vaults and escrow, ACH rates, remittances, ledger |
| `/insurance` | Your policies, slices you underwrite, the open market; insure a voyage, underwrite (batch) |
| `/futures` | Hub futures: create (batch), accept (batch), settle |
| `/ports`, `/ports/[id]` | Every port with filters and your presence; berths, dues, book, gossip, sailings, factor hire, lease, port events |
| `/zones` | Live piracy per sea zone; sponsor letters of marque or fund naval patrols; yours with prize money |
| `/leaderboard` | Season leaderboard (your rank), hall of fame, company lookup, expansion progress |
| `/company` | Profile, auto-remit settings, Resident Factors, bankruptcy |
| `/account` | Your API keys (revoke one or all) and passphrase change |

## Project Structure

```
src/
├── app/
│   ├── (auth)/              # Sign-in, register, company picker
│   ├── (game)/              # Every game page (see Pages)
│   └── api/kibb/            # Session routes, autopilot control, and /v1 proxy to the game API
├── components/kibb/         # Shared panels, tables, badges
├── instrumentation.ts       # Resumes enabled autopilots on server start
├── lib/kibb/
│   ├── client.ts            # Typed API client (Idempotency-Key, retries, 429 handling)
│   ├── fleet/               # Autopilot: world model, lane planner, ship agents, manager, ship names
│   ├── fleet-registry.ts    # In-process autopilots, one per company
│   ├── store.ts             # .kibb/store.json
│   ├── schema.ts            # Every API schema, generated: node scripts/gen-kibb-schema.mjs
│   └── types.ts             # Hand-written API types used by the autopilot
└── workers/kibb-fleet.ts    # CLI for the autopilot
```

The browser never sees a company key: `/api/kibb/v1/*` forwards to the game with the active company's stored key, and refuses key management, company founding and bankruptcy. Those go through dedicated routes: account actions use the signed-in player's key, changing company settings mints a two-minute `account_manage` key and revokes it straight after, and bankruptcy needs the company's name typed back and stops the autopilot first. Passphrases are passed through, never stored. It, and the autopilot route, act only for a signed-in player who owns the selected company (checked against the game, cached for 5 minutes); the company cookie alone does nothing.

## Scripts

```bash
pnpm dev      # Dashboard + autopilot, development
pnpm build    # Production build
pnpm start    # Production server (or: pm2 start ecosystem.config.cjs)
```
