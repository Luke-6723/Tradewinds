# Tradewinds

A trading game UI for managing your shipping company. Buy and sell goods at ports, manage your fleet, operate warehouses, and grow your treasury.

Connects to the game backend at `https://tradewinds.fly.dev`.

## Tech Stack

- **Next.js 15** with React 19 and TypeScript
- **Tailwind CSS 4** for styling
- **Base UI** for unstyled, accessible components
- **pnpm** as the package manager

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

Run the interactive setup script to register an account (or log in to an existing one), and create or select a company:

```bash
node scripts/setup.mjs
```

It will print out the values to add to `.env.local`. Alternatively, copy the template:

```bash
cp .env.local.example .env.local
```

| Variable | Description | Required |
|---|---|---|
| `TRADEWINDS_TOKEN` | JWT bearer token from login | ✅ |
| `TRADEWINDS_COMPANY_ID` | UUID of the company to manage | ✅ |
| `TRADEWINDS_API_URL` | Backend base URL | ❌ (defaults to `https://tradewinds.fly.dev`) |

> **Note:** New accounts require admin approval before trading is enabled.

### 3. Run the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
src/
├── app/
│   ├── (game)/          # All game pages (dashboard, fleet, market, etc.)
│   └── api/[...proxy]/  # API proxy — forwards requests to the backend
├── components/
│   ├── layout/          # Sidebar, header, events feed
│   └── ui/              # Reusable UI primitives (button, card, badge, etc.)
└── lib/
    ├── api/             # Per-domain API clients (fleet, market, trade, …)
    ├── types.ts         # TypeScript types matching the backend schema
    └── utils.ts         # Utility helpers
```

## Pages

| Route | Description |
|---|---|
| `/dashboard` | Treasury, reputation, upkeep breakdown, recent ledger, events |
| `/fleet` | All ships with status (docked / traveling) |
| `/fleet/[shipId]` | Ship detail — send to a new route |
| `/ports` | Port list with hub indicators |
| `/ports/[id]` | Port detail — traders, shipyard, open orders |
| `/market` | Order book — browse and place buy/sell orders |
| `/trade` | NPC trade — get a quote and execute it |
| `/warehouses` | Warehouse list — buy a warehouse at any port |
| `/warehouses/[warehouseId]` | Warehouse detail — capacity and inventory |
| `/goods` | Catalogue of all tradeable goods |

## How the API Proxy Works

All `/api/*` requests from the browser are intercepted by `src/app/api/[...proxy]/route.ts`, which:

1. Appends the path to `https://tradewinds.fly.dev/api/v1/`
2. Injects `Authorization: Bearer <TRADEWINDS_TOKEN>` and `tradewinds-company-id: <TRADEWINDS_COMPANY_ID>` headers
3. Streams the response back to the client

This keeps credentials server-side and out of the browser.

## Scripts

```bash
pnpm dev      # Start development server
pnpm build    # Production build
pnpm start    # Start production server
```
