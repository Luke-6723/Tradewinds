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
- **Phase bonus.** Expansion charters also earn a share of the tier's completion bonus, split by base value delivered, so a ton of cannons is worth far more than a ton of provisions. The value per ton comes from the live pool over the tier's projected base value (clamped to 6-20% of base). That expected share, discounted by a setting (75% by default), counts in lane choice and buy prices. The dashboard shows each company's share of the bonus so far.
- **Hold space.** Each gun takes 2 t of hold. With guns on "auto", a ship calling at a shipyard is refitted to the count that earns most on its lane, weighing cargo room against the cargo pirates are expected to take there. In phase-1 waters that is usually none. Surplus stores above what the voyage needs are moved out and sold when the hold is what limits a load.
- **Events.** It long-polls the company's event log: a ship's agent wakes the moment it arrives, is berthed from the queue, is evicted or hit by a hazard, and a posted, filled or expired charter refreshes the world within seconds so idle ships re-plan at once. Timers remain the fallback if the feed drops.
- **Sailing.** Buys up to the charter's break-even price, keeps stores at the route's safe figure, refuses water the hull isn't rated for (lane *and* sea-zone class), delivers from the roadstead when the per-ton berth lock would cost more than waiting out the base lock (several charters in one batch call), and times everything on the server's clock.
- **Freight.** Picks up Merchant Adventurers freight on legs it sails anyway when the reward beats the berth time it costs.
- **Cash.** Buying is paid from the port's banking region; it remits from other regions on demand and always keeps the reserve in the home region. A ship waiting for cash tries again as soon as another delivery pays.
- **Letters of marque** (off by default). Every 5 minutes it weighs each sea zone: rival cargo seen passing through over the last game day against the cost of a one-day marque and the extra piracy our own ships would face there. It sponsors the best one only when there are at least 3 laden rival passages a day, the expected prize is at least 1.5 times cost plus our own extra losses, and the spend stays within the budget (1,000 Cr in any 24 hours by default, the marque sized down to fit). The zone's 5,000 bps marque cap is respected.
- **Underwriting** (off by default). Every minute it reads other companies' open policies and writes slices on those someone other than you has already partly covered (in practice Lloyd's, which writes only when the premium is at least 1.25 times its expected loss + 25 bps, so that policy's loss is at most (premium - 25) / 1.25). The edge over that bound must reach the minimum (150 bps by default, so premiums from about 650 bps). Uncovered policies are left alone: young ones wait for Lloyd's review, older ones were declined. Slices are capped per policy (3,000 Cr) and in total escrow (5,000 Cr), paid only from spare cash above each region's floor; policies older than 36 game hours are skipped as likely at sea. A sinking costs the whole slice, so keep the budget to what you can lose.
- **Expansion re-posts and stalls.** Expansion charters are re-posted when they lapse, so their expiry doesn't end the work: lanes keep planning on them, and the buyer counts on them for as long as the tier lasts at its recent pace. A posting nobody delivers to comes back richer (about +25% pay on 75% of the tons; the autopilot learns the real figures when it sees one). It watches every expansion charter for that, values loads landing after a stalled posting lapses at the expected re-post, and with "hold for re-post" on (off by default) a load landing up to 4 game hours before the lapse waits in the roadstead for it, delivering at once if anyone else delivers first. The dashboard lists each charter's state and the tier's ETA.
- **Scarce cash.** When cash is what limits the fleet (a ship waits for it, or what's spare wouldn't fill half a load), lanes are charged for the money their loads tie up, at half the fleet's own return on cash, so high-margin loads win over thin ones that lock up the same money. Once the tier is 90% done or due within 2 hours, and for an hour after it turns over, the buyer keeps a share of spare cash back (40% by default) for the next tier's charters, which nobody can reach at first.
- **AI support (Claude)** (off by default; switch it Off / Shadow / Live on the fleet panel, needs `ANTHROPIC_API_KEY` in `.env.local`). Claude acts as strategist (Opus 5.5 by default, or Sonnet 5.5 at half the price; low thinking effort by default, which is most of a call's cost): every 60 minutes by default (half that near a phase turnover; a routine call is skipped when nothing important changed), and soon after a phase change, a stall escalation, a lost ship or a trip far below its estimate, it reads a digest of the fleet and the world and answers with directives. Live, they apply until they lapse (15-180 min): temporary setting overrides within limits (phase-bonus weight 50-100%, cash kept back 0-70%, minimum margin 0.5-2x yours, holding for re-posts), a bias of 0.5-1.5x on lane ranks (only lanes that already pass every check), calls on stalled expansion charters (wait for the re-post or deliver now), and holding the ship buyer. Shadow logs the same answers without applying them. Ships, charters, lanes and rivals appear to it only as aliases, and game notices only as fields Claude Haiku 5.5 extracted, so nothing other players write reaches it. Spend is capped per UTC day and in total ($2 and $180 by default; a call whose worst case could pass a cap is skipped); half the fleet idle under its directives for 20 minutes clears them; if trips under its advice earn under 80% of trips without, it drops back to shadow. Every decision is kept in MongoDB (`ai_decisions`); the dashboard shows the spend, what is in force and why. The planner also learns two figures on its own: how often a stalled posting stays stalled to its lapse, and how fast remembered bids drift; and it discounts public charters where laden rivals are seen heading first.
- **Buying ships.** Wherever the fleet has presence at a shipyard (a ship there, or a Resident Factor) it quotes every allowed class, scores each by payback hours on its best lane net of the extra fleet upkeep, builds the quickest payback within your limit (unarmed unless guns are on "full"). With no presence at any yard, it prices a build at the yard nearest the fleet's work from the last quotes it saw; if that pays back (fee included) it hires a Resident Factor there (750 Cr), builds, and dismisses the factor straight after, so building never waits for a ship to pass by and no factor salary runs on (setting, on by default). New ships are named after random Discord bots from the [TopStats](https://topstats.gg) API (set `TOPSTATS_API_KEY`), or a bundled list without a key.

Settings (cash reserve, minimum margin, max ships, max payback, allowed classes, guns, phase-bonus weight, freight, yard factor, hold for re-post, cash kept back near a new phase, marques and underwriting with their budgets) apply live; the dashboard sends only the fields you changed. The panel also shows where each ship's time goes (laden, empty at sea, in port, idle), its Cr/hour, and each finished trip's planner estimate against what it made. The home-region reserve never drops below 1.5 game days of fleet upkeep, whatever the setting, and every other region keeps 200 Cr for dues and stores. The enabled flag persists, so a running autopilot resumes when the server restarts, and so does its progress: each ship's lane and whether its cargo is aboard, its sell floors, trips, stats, purchases, the log, the event cursor and what the world model had learned (prices, stalled charters, tier pace, rival sightings). That is saved to MongoDB when `MONGODB_URI` is set (`fleet_snapshots`, one document per company, and `fleet_trips`, every finished trip), and always to `.kibb/fleet-<company>.json`; on start the newer copy wins. Trips, loads, deliveries and buyer actions save at once, everything else at most every 15 s. On SIGINT/SIGTERM the server saves before exiting when run with `NEXT_MANUAL_SIG_HANDLE=true` (the pm2 config sets it). A lease file in `.kibb/` stops a second process (another server or the CLI) from running the same company. Don't give manual orders to ships while it runs.

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
| `/map` | Live map: ships placed along their routes, sea lanes, ports, piracy per sea zone, rival ships at their estimated positions |
| `/rivals` | Rival ships seen at ports where you have presence (and by a running autopilot), where each probably is now, rival traffic per sea zone, the marque verdict for each zone, auto-marque settings and your marques |
| `/events` | Live company event feed (long poll) and the world events history |
| `/fleet` | All ships; shipyard quotes and builds (turnkey or own materials), names from TopStats |
| `/fleet/[shipId]` | Ship detail: dock/roadstead, depart with route and stores check, stores in/out, guns, warehouse load/unload, charters and freight here, insurance, convoys |
| `/convoys` | Convoys: organise, join (as escort), leave; approve, reject, kick, invite |
| `/market` | Order books; IOC or GTC orders (ship or warehouse), resting orders and cancels, fills, batch orders |
| `/contracts` | Charters (deliver, batch deliver), freight (accept, batch accept, deliver, issue your own) |
| `/warehouses` | Leases, inventories, load and unload ships |
| `/treasury` | Vaults and escrow, ACH rates, remittances, ledger |
| `/insurance` | Your policies, slices you underwrite (with collateral and premium share), the open market with each policy's cover, Lloyd's-implied loss bound and edge; insure a voyage with the lane's past premiums as a guide, underwrite (batch) |
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
