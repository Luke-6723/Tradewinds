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
 *   KIBB_CONVOYS=0        don't sail in convoys with our other ships
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
 *   KIBB_MAX_DEBT_PCT     most owed on loans, % of net worth (default 25)
 *   KIBB_MIN_LOAN_RETURN_X  a loan must earn this many times its interest over its term (default 2)
 *   KIBB_IDLE_CASH=0      don't quote spare cash on players' secured loan requests (clean borrowers, never our own companies)
 *   KIBB_SHIP_DEALS=0     don't buy ships for sale under building cost, nor build commissions to order
 *   KIBB_ENVELOPES=0      don't sell sealed news (intelligence envelopes) from our quays
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
 *                         default; an issued one can't be withdrawn), and give money orders (borrow for a load or a hull
 *                         within the debt cap, repay a loan early, build a commission to order) through every check;
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
      convoys: env.KIBB_CONVOYS ? env.KIBB_CONVOYS !== "0" : undefined,
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
      maxDebtPct: env.KIBB_MAX_DEBT_PCT ? Number(env.KIBB_MAX_DEBT_PCT) : undefined,
      minLoanReturnX: env.KIBB_MIN_LOAN_RETURN_X ? Number(env.KIBB_MIN_LOAN_RETURN_X) : undefined,
      idleCash: env.KIBB_IDLE_CASH ? env.KIBB_IDLE_CASH !== "0" : undefined,
      shipDeals: env.KIBB_SHIP_DEALS ? env.KIBB_SHIP_DEALS !== "0" : undefined,
      envelopes: env.KIBB_ENVELOPES ? env.KIBB_ENVELOPES !== "0" : undefined,
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
