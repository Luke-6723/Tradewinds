/**
 * CLI for the fleet autopilot — runs it without the dashboard (e.g. under pm2 on a server).
 * The dashboard runs the same autopilot in-process; don't run both for one company.
 *
 * Env (e.g. in .env.local):
 *   KIBB_API_KEY          company-bound key (log in with company_id set)   — required
 *   KIBB_API_URL          default https://tradewinds.kibb.io
 *   KIBB_AUTO_BUY=0       don't build ships
 *   KIBB_MAX_SHIPS        fleet size cap (default 8)
 *   KIBB_RESERVE_CR       cash kept in the home region (default 1500)
 *   KIBB_MIN_MARGIN_CR    min profit per ton after customs and fees (default 15)
 *   KIBB_MAX_PAYBACK_H    only build ships that pay back within this (default 8)
 *   KIBB_BUY_CLASSES      comma list (default collier,brigantine,fluyt,cutter)
 *   KIBB_FREIGHT=0        don't carry freight on empty legs
 *
 * Run: pnpm exec tsx --env-file=.env.local src/workers/kibb-fleet.ts
 */

import { DEFAULT_FLEET_SETTINGS as D, FleetManager, sanitizeSettings, type FleetSettings } from "@/lib/kibb/fleet/manager";
import { STORE_DIR } from "@/lib/kibb/store";

const env = process.env;
const cr = (v: string) => Math.round(Number(v) * 100);

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
    }),
  };
} catch (e) {
  console.error(`bad setting: ${(e as Error).message}`);
  process.exit(1);
}

// Same lease directory as the dashboard, so the two never run one company at once.
const manager = new FleetManager(
  { apiKey: env.KIBB_API_KEY ?? "", baseUrl: env.KIBB_API_URL, settings, leaseDir: STORE_DIR },
  { onLog: ({ at, source, msg }) => console.log(`${at} [${source}] ${msg}`) },
);

async function main(): Promise<void> {
  if (!env.KIBB_API_KEY) {
    console.error("KIBB_API_KEY is not set (log in with company_id to get a company-bound key)");
    process.exit(1);
  }
  process.on("SIGINT", () => void manager.stop());
  process.on("SIGTERM", () => void manager.stop());
  manager.start();
  await manager.done;
  if (manager.state.status === "failed") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
