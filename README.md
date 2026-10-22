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

## Fleet autopilot

Runs inside the Next.js server; start and stop it from the dashboard. It puts every ship under its own agent and keeps them busy:

- **Lanes.** A planner scores every open charter × every port that makes the good, per hull: margin after customs, remittance fees and the price impact of what other ships are already bound to buy, divided by the whole loop's time (deadhead, berth locks, laden passage, return). Each ship takes the best lane still free; reservations spread ships across charters and sources.
- **Sailing.** Buys up to the charter's break-even price, keeps stores at the route's safe figure, refuses water the hull isn't rated for (lane *and* sea-zone class), delivers from the roadstead when the per-ton berth lock would cost more than waiting out the base lock, and times everything on the server's clock.
- **Freight.** Picks up Merchant Adventurers freight on legs it sails anyway when the reward beats the berth time it costs.
- **Cash.** Buying is paid from the port's banking region; it remits from other regions on demand and always keeps the reserve in the home region.
- **Buying ships.** Whenever a ship calls at a shipyard it quotes every allowed class, scores each by payback hours on its best lane net of the extra fleet upkeep, builds the quickest payback within your limit and arms it. New ships are named after random Discord bots from the [TopStats](https://topstats.gg) API (set `TOPSTATS_API_KEY`), or a bundled list without a key.

Settings (cash reserve, minimum margin, max ships, max payback, allowed classes, arming, freight) apply live. The home-region reserve never drops below 1.5 game days of fleet upkeep, whatever the setting, and every other region keeps 200 Cr for dues and stores. The enabled flag persists, so a running autopilot resumes when the server restarts. A lease file in `.kibb/` stops a second process (another server or the CLI) from running the same company. Don't give manual orders to ships while it runs.

To run it without the dashboard (e.g. on a server):

```bash
pnpm exec tsx --env-file=.env.local src/workers/kibb-fleet.ts
```

with `KIBB_API_KEY` (a company-bound key) in `.env.local`. See the header of [src/workers/kibb-fleet.ts](src/workers/kibb-fleet.ts) for its settings.

## Pages

| Route | Description |
|---|---|
| `/login`, `/register` | Player sign-in and registration |
| `/companies` | Pick or found a company |
| `/dashboard` | Cash, fleet, phase-2 progress, leaderboard; fleet autopilot controls, per-ship lanes, purchases and log; ships, vaults, charters |
| `/map` | Live map: ships placed along their routes, sea lanes, ports, piracy per sea zone |
| `/fleet` | All ships: status, position, cargo, stores |
| `/fleet/[shipId]` | Ship detail; dock, move to the roadstead, depart with a route and stores check |
| `/market` | Order books for ports you have presence at; IOC buy/sell into a berthed ship |
| `/ports` | Every port: what it makes and imports, customs |
| `/ports/[id]` | Port detail: berths, dues, local contracts, book, coffee-house gossip, recent sailings |

## Project Structure

```
src/
├── app/
│   ├── (auth)/              # Sign-in, register, company picker
│   ├── (game)/              # Dashboard, fleet, market, ports
│   └── api/kibb/            # Session routes, autopilot control, and /v1 proxy to the game API
├── components/kibb/         # Shared panels, tables, badges
├── instrumentation.ts       # Resumes enabled autopilots on server start
├── lib/kibb/
│   ├── client.ts            # Typed API client (Idempotency-Key, retries, 429 handling)
│   ├── fleet/               # Autopilot: world model, lane planner, ship agents, manager, ship names
│   ├── fleet-registry.ts    # In-process autopilots, one per company
│   ├── store.ts             # .kibb/store.json
│   └── types.ts             # API types
└── workers/kibb-fleet.ts    # CLI for the autopilot
```

The browser never sees a company key: `/api/kibb/v1/*` forwards to the game with the active company's stored key, and refuses key management, company founding and bankruptcy. It, and the autopilot route, act only for a signed-in player who owns the selected company (checked against the game, cached for 5 minutes); the company cookie alone does nothing.

## Scripts

```bash
pnpm dev      # Dashboard + autopilot, development
pnpm build    # Production build
pnpm start    # Production server (or: pm2 start ecosystem.config.cjs)
```
