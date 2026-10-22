# Tradewinds

A dashboard and trading bot for [Tradewinds](https://tradewinds.kibb.io/), the headless Age of Sail trading game played over an HTTP API. Sign in, found or pick a company, watch your ships, trade at port order books, and let the charter runner carry goods to Admiralty charters for you.

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
- Picking a company mints a company-bound API key, saved server-side in `.kibb/store.json` (gitignored) so the charter runner can trade while no browser is open.
- Logins are rate limited (12 a minute), so don't hammer the sign-in form.

| Variable | Description | Default |
|---|---|---|
| `KIBB_API_URL` | Game API base URL | `https://tradewinds.kibb.io` |
| `KIBB_STORE_DIR` | Where keys and runner settings are kept | `.kibb/` |

## Charter runner

Runs inside the Next.js server; start and stop it from the dashboard. It shuttles one ship between a source port and a charter port: buys the charter's good at the source (never above the charter's pay minus your margin and customs), carries it in, delivers it, and repeats. It keeps the crew's stores topped up, refuses routes the hull isn't rated for, and respects turnaround locks.

Default lane: Le Havre → Portsmouth provisions for the phase-2 Admiralty charter, with the starter hoy. Ship, ports, good, margin and cash reserve are editable in the runner's settings.

The enabled flag persists, so a runner left on resumes when the server restarts. Don't run it alongside manual orders for the same ship.

To run it without the dashboard (e.g. on a server):

```bash
pnpm exec tsx --env-file=.env.local src/workers/kibb-charter.ts
```

with `KIBB_API_KEY` (a company-bound key) in `.env.local`. See the header of [src/workers/kibb-charter.ts](src/workers/kibb-charter.ts) for its settings and `KIBB_DRY_RUN=1`.

## Pages

| Route | Description |
|---|---|
| `/login`, `/register` | Player sign-in and registration |
| `/companies` | Pick or found a company |
| `/dashboard` | Cash, fleet, phase-2 progress, leaderboard; charter runner controls and log; ships, vaults, charters |
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
│   └── api/kibb/            # Session routes, runner control, and /v1 proxy to the game API
├── components/kibb/         # Shared panels, tables, badges
├── instrumentation.ts       # Resumes enabled runners on server start
├── lib/kibb/
│   ├── client.ts            # Typed API client (Idempotency-Key, retries, 429 handling)
│   ├── charter-runner.ts    # The charter loop
│   ├── runner-registry.ts   # In-process runners, one per company
│   ├── store.ts             # .kibb/store.json
│   └── types.ts             # API types
└── workers/kibb-charter.ts  # CLI for the runner
```

The browser never sees a company key: `/api/kibb/v1/*` forwards to the game with the active company's stored key, and refuses key management, company founding and bankruptcy.

## Scripts

```bash
pnpm dev      # Dashboard + runner, development
pnpm build    # Production build
pnpm start    # Production server (or: pm2 start ecosystem.config.cjs)
```
