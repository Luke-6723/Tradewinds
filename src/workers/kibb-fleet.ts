/**
 * CLI for the fleet autopilot — runs it without the dashboard (e.g. under pm2 on a server).
 * The dashboard runs the same autopilot in-process; don't run both for one company.
 *
 * Env (e.g. in .env.local):
 *   KIBB_API_KEY          company-bound key (log in with company_id set)   — required. A login key lasts 24 h
 *                         unless you pass ttl_seconds (up to 31536000, a year); a sub-key minted with a Bearer key
 *                         can't outlive that key; create-key with handle + passphrase and no ttl_seconds never
 *                         expires. The autopilot stops when the key expires, and warns from whoami.expires_at at
 *                         7 days, 1 day and 1 hour left: mint a new key and restart before then.
 *   KIBB_API_URL          default https://tradewinds.kibb.io
 *   KIBB_AUTO_BUY=0       don't build ships
 *   KIBB_MAX_SHIPS        fleet size cap (default 8)
 *   KIBB_RESERVE_CR       cash kept in the home region (default 1500)
 *   KIBB_MIN_MARGIN_CR    min profit per ton after customs and fees (default 15)
 *   KIBB_MAX_PAYBACK_H    only build ships that pay back within this (default 8)
 *   KIBB_BUY_CLASSES      comma list (default collier,brigantine,fluyt,cutter)
 *   KIBB_FREIGHT=0        don't carry freight on empty legs
 *   KIBB_PASSENGERS=0     don't offer spare hold to passengers on voyages sailed anyway (1|true on, 0|false off; any other
 *                         value stops the CLI with an error, as for the other new switches below)
 *   KIBB_PAX_VOYAGES=0    don't count waiting passengers' fares in lane choice nor sail for fares alone (on by default, with
 *                         KIBB_PASSENGERS on: a passage for fares alone nobody boarded is never sailed empty; strict 1|true / 0|false)
 *   KIBB_CONVOYS=0        don't sail in convoys with our other ships
 *   KIBB_ESCORT_FEES=0    keep our convoys private (on by default: one formed by an armed ship of ours is announced public, by
 *                         approval, at our slowest member's speed, charging other companies' ships an escort fee per ton of hold
 *                         that our escorts share on arrival; joiners no slower than us only; strict 1|true / 0|false)
 *   KIBB_RIVAL_INTEL=0    rival intel from quay sightings only (no public policies, convoys or leaderboard)
 *   KIBB_BYOM=0           always build turnkey (not from materials bought at the yard)
 *   KIBB_GUNS             auto (refit each ship to its lane's piracy, default) | full | off
 *   KIBB_BONUS_WEIGHT     % of the expected phase-completion bonus counted in charter pay (default 75)
 *   KIBB_STORM_WEIGHT     % of expected storm losses counted against a lane (default 100, up to 200; 0 ignores storms)
 *   KIBB_YARD_FACTOR=0    don't hire a factor at a shipyard so the buyer can build there any time
 *   KIBB_CAPTURE_ESCALATIONS=0  never let a stalled expansion posting lapse for its richer re-post (on by default)
 *   KIBB_HOLD_REPOST=1    always let a stalled posting lapse in its last 4 game hours, whatever the math says
 *   KIBB_PHASE_CHEST      % of spare cash the buyer keeps back when the tier nears completion (default 40)
 *   KIBB_RESIZE=0         don't size each load again at its source (and spend as before)
 *   KIBB_CASH_DUE         % of the cash our ships at sea are due to be paid that loads may count on (default 60; 0: cash in hand only)
 *   KIBB_WORLD_EVENTS=0   don't plan on world events' prices or on crisis charters not yet listed
 *   KIBB_LEVERAGE=0       never borrow (on by default: bridge a new ship or a load cash can't fund, when it clearly pays,
 *                         on the Goldsmiths' instant quote, refinanced by a cheaper player quote; the key needs treasury_remit.
 *                         A default on a Goldsmiths' instant loan takes the ship at 35% of her rebuild value, no surplus,
 *                         the rest still owed; after any walk-away they lend nothing for a real day, nor does the autopilot)
 *   KIBB_MORTGAGES=0      never build on a ship mortgage (on by default, with leverage only: the Goldsmiths pay 60% of a turnkey
 *                         build, 80% oceanic, amortised over 180 game days, one at a time, within the debt cap; strict 1|true / 0|false)
 *   KIBB_MAX_DEBT_PCT     most owed on loans, % of net worth (default 25)
 *   KIBB_MIN_LOAN_RETURN_X  a loan must earn this many times its interest over its term (default 2)
 *   KIBB_IDLE_CASH=0      don't quote spare cash on players' secured loan requests (clean borrowers, never our own companies)
 *   KIBB_VENTURES=0       never raise outside capital (on by default, with KIBB_RESIZE on: a load its source finds cash-limited with no
 *                         load loan planned may become a commenda venture: market goods only, a 3-6 game-hour raising window, our own
 *                         cash for the load in as our stake, cancelled at the buy if too little was raised, sailed alone to its port,
 *                         sold through it and settled; one at a time; strict 1|true / 0|false)
 *   KIBB_DEPOSITS=0       never put idle cash on bank deposit (on by default: on demand only, with healthy banks, insured first,
 *                         2,500 Cr a bank unless insured with strong reserves, withdrawn when the fleet needs it; strict 1|true / 0|false)
 *   KIBB_DEPOSIT_BUDGET_CR  most kept on bank deposit at once, all banks together (default 25000)
 *   KIBB_RUN_BANK=1       charter and run our own bank (OFF by default; strict 1|true / 0|false): a 10,000 Cr fee to the Crown, never
 *                         refunded, and 50,000 Cr of own funds; deposit rates 0 / 0, exchange fees for drafts and one lending line;
 *                         never wound down by the autopilot
 *   KIBB_BANK_MIN_WORTH_CR  net worth our bank waits for before it is chartered (default 150000)
 *   KIBB_BANK_LENDING_CR  most our bank's lending line has out (default 20000)
 *   KIBB_SHIP_DEALS=0     don't buy ships for sale under building cost, nor build commissions to order
 *   KIBB_ENVELOPES=0      don't sell sealed news (intelligence envelopes) from our quays
 *   KIBB_NEWS_PACKETS=0   never build or run a news packet (on by default: only when Lloyd's news desk has bought enough envelopes
 *                         lately that one packet's share beats her upkeep and pays her hull back within KIBB_MAX_PAYBACK_H, one packet
 *                         under the buyer's rules, sealed, shuttling between hubs selling her news; sold if her sales don't cover her
 *                         upkeep over 3 game days; strict 1|true / 0|false)
 *   KIBB_COMPONENTS=0     never fit components (on by default: at a yard call, never a detour, a component whose readable strengths
 *                         repay twice its licence, materials, labour and 4% fitting fee over the season left; permanent; never on an
 *                         insured ship; strict 1|true / 0|false)
 *   KIBB_COMPONENT_BUDGET_CR  most spent on components in any 24 real hours (default 20000)
 *   KIBB_RND=1            start research projects (OFF by default; strict 1|true / 0|false): a random design, a start fee never refunded
 *                         and upkeep every game day for two to three real days; only when its whole expected cost fits the budget
 *   KIBB_RND_BUDGET_CR    most one research project may cost: fee, upkeep and prototype materials (default 50000)
 *   KIBB_SHIP_SHARES=0    never buy or sell ship shares (on by default: more 64ths only of ships we already hold, when her earnings as
 *                         our holdings show them pay the listing back; our 64ths of a ship that stopped earning listed; strict 1|true / 0|false)
 *   KIBB_SHARES_BUDGET_CR most the autopilot has in ship shares at once (default 10000)
 *   KIBB_BREAKUP=0        never break up dead weight (on by default: a ship earning under her upkeep for days, sold to a yard for 35%
 *                         of her rebuild value when the upkeep saved makes up the net worth it gives away; strict 1|true / 0|false)
 *   KIBB_RELOCATE=0       never move the home port (on by default: 2,500 Cr, when the remit fees it saves beat that 1.5x over, at most
 *                         once in 3 real days; strict 1|true / 0|false)
 *   KIBB_SMUGGLING=1      (1|true|resume on, 0|false off; any other value stops the CLI with an error)
 *                         the Free Trade (off by default; RISKY): one dedicated ship runs small loads of contraband from a
 *                         cove to a fresh want, only through zones no patrol works and only when the expected gain is twice
 *                         the expected loss. A seizure forfeits the ship and everything aboard (insurance pays nothing) and
 *                         puts a smuggling conviction on the company's public credit record; the mode then stays off until
 *                         restarted with KIBB_SMUGGLING=resume. Needs a key holding the `underworld` scope (mint one with it).
 *   KIBB_SMUGGLE_MAX_TONS most tons one smuggling run buys (default 5)
 *   KIBB_SMUGGLE_MAX_CR   most one smuggling run spends on contraband (default 3000)
 *   KIBB_AI               AI support (Claude): off (default) | shadow | live; needs ANTHROPIC_API_KEY. Live it may set any
 *                         setting but its own within your ceilings (KIBB_MAX_SHIPS and the marque and underwriting budgets
 *                         never exceeded, KIBB_RESERVE_CR only raised), ban ports/zones/goods/charters, order single ships,
 *                         order one build, issue marques or patrols within the marque budget (1,000 Cr in 24 h by
 *                         default; an issued one can't be withdrawn), give money orders (borrow for a load or a hull
 *                         within the debt cap, repay a loan early, build a commission to order) and housekeeping orders
 *                         (break up a ship, move the home port; never while those switches are off) through every check;
 *                         every order and its outcome is logged
 *   KIBB_AI_DAILY_USD     AI spend cap per UTC day in US$ (default 2)
 *   KIBB_AI_MODEL         claude-opus-5-5 (default) | claude-sonnet-5-5
 *   KIBB_AI_EFFORT        low (default) | medium | high
 *   KIBB_AI_INTERVAL_MIN  minutes between routine AI calls (default 60)
 *   KIBB_AI_TOTAL_USD     AI spend cap in total in US$ (default 180)
 *
 * Run: pnpm exec tsx --env-file=.env.local src/workers/kibb-fleet.ts
 */

import { DEFAULT_FLEET_SETTINGS as D, FleetManager, sanitizeSettings, type FleetSettings } from "@/lib/kibb/fleet/manager";
import { STORE_DIR } from "@/lib/kibb/store";

const env = process.env;
const cr = (v: string) => Math.round(Number(v) * 100);

/** KIBB_SMUGGLING is risky: only 1/true/resume turn it on and 0/false off; anything else (a typo) is refused, never read as on. */
function smugglingEnv(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const x = v.trim().toLowerCase();
  if (x === "1" || x === "true" || x === "resume") return true;
  if (x === "0" || x === "false") return false;
  throw new Error(`KIBB_SMUGGLING must be 1, true or resume (on) or 0, false (off), not "${v}"`);
}

/**
 * The switches added with passengers, mortgages, housekeeping, banks, passenger voyages, ventures, escort fees, news packets, components,
 * research and ship shares are read strictly too: only 1/true turn one on and 0/false off;
 * anything else (a typo) is refused, never guessed. (The older flags keep their loose reading: anything but "0" is on.)
 */
function switchEnv(name: string, v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const x = v.trim().toLowerCase();
  if (x === "1" || x === "true") return true;
  if (x === "0" || x === "false") return false;
  throw new Error(`${name} must be 1 or true (on) or 0 or false (off), not "${v}"`);
}

let settings: FleetSettings;
try {
  settings = {
    ...D,
    ...sanitizeSettings({
      autoBuy: env.KIBB_AUTO_BUY ? env.KIBB_AUTO_BUY !== "0" : undefined,
      maxShips: env.KIBB_MAX_SHIPS ? Number(env.KIBB_MAX_SHIPS) : undefined,
      reservePence: env.KIBB_RESERVE_CR ? cr(env.KIBB_RESERVE_CR) : undefined,
      minMarginPence: env.KIBB_MIN_MARGIN_CR ? cr(env.KIBB_MIN_MARGIN_CR) : undefined,
      maxPaybackHours: env.KIBB_MAX_PAYBACK_H ? Number(env.KIBB_MAX_PAYBACK_H) : undefined,
      buyClasses: env.KIBB_BUY_CLASSES ? env.KIBB_BUY_CLASSES.split(",").map((x) => x.trim()) : undefined,
      useFreight: env.KIBB_FREIGHT ? env.KIBB_FREIGHT !== "0" : undefined,
      usePassengers: switchEnv("KIBB_PASSENGERS", env.KIBB_PASSENGERS),
      passengerVoyages: switchEnv("KIBB_PAX_VOYAGES", env.KIBB_PAX_VOYAGES),
      convoys: env.KIBB_CONVOYS ? env.KIBB_CONVOYS !== "0" : undefined,
      escortFees: switchEnv("KIBB_ESCORT_FEES", env.KIBB_ESCORT_FEES),
      rivalIntel: env.KIBB_RIVAL_INTEL ? env.KIBB_RIVAL_INTEL !== "0" : undefined,
      byomBuilds: env.KIBB_BYOM ? env.KIBB_BYOM !== "0" : undefined,
      guns: env.KIBB_GUNS ? (env.KIBB_GUNS as FleetSettings["guns"]) : undefined,
      bonusWeightPct: env.KIBB_BONUS_WEIGHT ? Number(env.KIBB_BONUS_WEIGHT) : undefined,
      stormWeightPct: env.KIBB_STORM_WEIGHT ? Number(env.KIBB_STORM_WEIGHT) : undefined,
      yardFactor: env.KIBB_YARD_FACTOR ? env.KIBB_YARD_FACTOR !== "0" : undefined,
      holdForRepost: env.KIBB_HOLD_REPOST ? env.KIBB_HOLD_REPOST !== "0" : undefined,
      captureEscalations: env.KIBB_CAPTURE_ESCALATIONS ? env.KIBB_CAPTURE_ESCALATIONS !== "0" : undefined,
      phaseChestPct: env.KIBB_PHASE_CHEST ? Number(env.KIBB_PHASE_CHEST) : undefined,
      resizeLoads: env.KIBB_RESIZE ? env.KIBB_RESIZE !== "0" : undefined,
      cashDuePct: env.KIBB_CASH_DUE ? Number(env.KIBB_CASH_DUE) : undefined,
      actOnEvents: env.KIBB_WORLD_EVENTS ? env.KIBB_WORLD_EVENTS !== "0" : undefined,
      leverage: env.KIBB_LEVERAGE ? env.KIBB_LEVERAGE !== "0" : undefined,
      mortgages: switchEnv("KIBB_MORTGAGES", env.KIBB_MORTGAGES),
      maxDebtPct: env.KIBB_MAX_DEBT_PCT ? Number(env.KIBB_MAX_DEBT_PCT) : undefined,
      minLoanReturnX: env.KIBB_MIN_LOAN_RETURN_X ? Number(env.KIBB_MIN_LOAN_RETURN_X) : undefined,
      idleCash: env.KIBB_IDLE_CASH ? env.KIBB_IDLE_CASH !== "0" : undefined,
      ventures: switchEnv("KIBB_VENTURES", env.KIBB_VENTURES),
      deposits: switchEnv("KIBB_DEPOSITS", env.KIBB_DEPOSITS),
      depositBudgetPence: env.KIBB_DEPOSIT_BUDGET_CR ? cr(env.KIBB_DEPOSIT_BUDGET_CR) : undefined,
      runBank: switchEnv("KIBB_RUN_BANK", env.KIBB_RUN_BANK),
      bankMinNetWorthPence: env.KIBB_BANK_MIN_WORTH_CR ? cr(env.KIBB_BANK_MIN_WORTH_CR) : undefined,
      bankLendingBudgetPence: env.KIBB_BANK_LENDING_CR ? cr(env.KIBB_BANK_LENDING_CR) : undefined,
      shipDeals: env.KIBB_SHIP_DEALS ? env.KIBB_SHIP_DEALS !== "0" : undefined,
      envelopes: env.KIBB_ENVELOPES ? env.KIBB_ENVELOPES !== "0" : undefined,
      newsPackets: switchEnv("KIBB_NEWS_PACKETS", env.KIBB_NEWS_PACKETS),
      components: switchEnv("KIBB_COMPONENTS", env.KIBB_COMPONENTS),
      componentBudgetPence: env.KIBB_COMPONENT_BUDGET_CR ? cr(env.KIBB_COMPONENT_BUDGET_CR) : undefined,
      rndResearch: switchEnv("KIBB_RND", env.KIBB_RND),
      rndBudgetPence: env.KIBB_RND_BUDGET_CR ? cr(env.KIBB_RND_BUDGET_CR) : undefined,
      shipShares: switchEnv("KIBB_SHIP_SHARES", env.KIBB_SHIP_SHARES),
      sharesBudgetPence: env.KIBB_SHARES_BUDGET_CR ? cr(env.KIBB_SHARES_BUDGET_CR) : undefined,
      autoBreakUp: switchEnv("KIBB_BREAKUP", env.KIBB_BREAKUP),
      autoRelocate: switchEnv("KIBB_RELOCATE", env.KIBB_RELOCATE),
      smuggling: smugglingEnv(env.KIBB_SMUGGLING),
      smuggleMaxTons: env.KIBB_SMUGGLE_MAX_TONS ? Number(env.KIBB_SMUGGLE_MAX_TONS) : undefined,
      smuggleMaxPence: env.KIBB_SMUGGLE_MAX_CR ? cr(env.KIBB_SMUGGLE_MAX_CR) : undefined,
      ai: env.KIBB_AI ? (env.KIBB_AI as FleetSettings["ai"]) : undefined,
      aiDailyCapUsd: env.KIBB_AI_DAILY_USD ? Number(env.KIBB_AI_DAILY_USD) : undefined,
      aiTotalCapUsd: env.KIBB_AI_TOTAL_USD ? Number(env.KIBB_AI_TOTAL_USD) : undefined,
      aiModel: env.KIBB_AI_MODEL ? (env.KIBB_AI_MODEL as FleetSettings["aiModel"]) : undefined,
      aiEffort: env.KIBB_AI_EFFORT ? (env.KIBB_AI_EFFORT as FleetSettings["aiEffort"]) : undefined,
      aiIntervalMin: env.KIBB_AI_INTERVAL_MIN ? Number(env.KIBB_AI_INTERVAL_MIN) : undefined,
    }),
  };
} catch (e) {
  console.error(`bad setting: ${(e as Error).message}`);
  process.exit(1);
}

// Same lease directory as the dashboard, so the two never run one company at once.
const manager = new FleetManager(
  { apiKey: env.KIBB_API_KEY ?? "", baseUrl: env.KIBB_API_URL, settings, leaseDir: STORE_DIR, resumeSmuggling: env.KIBB_SMUGGLING?.trim().toLowerCase() === "resume" },
  { onLog: ({ at, source, msg }) => console.log(`${at} [${source}] ${msg}`) },
);

async function main(): Promise<void> {
  if (!env.KIBB_API_KEY) {
    console.error("KIBB_API_KEY is not set (log in with company_id to get a company-bound key)");
    process.exit(1);
  }
  // stop() saves the progress and releases the lease; exit explicitly, since the database
  // connection would otherwise keep the process alive.
  const shutdown = () => void manager.stop().finally(() => process.exit(manager.state.status === "failed" ? 1 : 0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  manager.start();
  await manager.done;
  await manager.stop();
  process.exit(manager.state.status === "failed" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
