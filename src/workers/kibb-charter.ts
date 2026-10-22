/**
 * CLI for the charter runner — runs it without the dashboard (e.g. under pm2 on a server).
 * The dashboard runs the same runner in-process; don't run both against one ship.
 *
 * Env (e.g. in .env.local):
 *   KIBB_API_KEY        company-bound key (log in with company_id set)   — required
 *   KIBB_API_URL        default https://tradewinds.kibb.io
 *   KIBB_SHIP_ID        ship to run (default: the company's first ship)
 *   KIBB_SOURCE_PORT    where the goods are bought        (default le_havre)
 *   KIBB_CHARTER_PORT   where the charter takes delivery  (default portsmouth)
 *   KIBB_COMMODITY      charter good                      (default provisions)
 *   KIBB_MIN_MARGIN_CR  min profit per ton after customs  (default 20)
 *   KIBB_RESERVE_CR     cash left in the vault for dues and stores (default 1000)
 *   KIBB_DRY_RUN=1      run one tick, log the writes it would make, and exit
 *
 * Run: pnpm exec tsx --env-file=.env.local src/workers/kibb-charter.ts
 */

import { CharterRunner, DEFAULT_CHARTER_SETTINGS as D } from "@/lib/kibb/charter-runner";

const env = process.env;
const runner = new CharterRunner(
  {
    apiKey:         env.KIBB_API_KEY ?? "",
    baseUrl:        env.KIBB_API_URL,
    shipId:         env.KIBB_SHIP_ID ?? D.shipId,
    sourcePort:     env.KIBB_SOURCE_PORT ?? D.sourcePort,
    charterPort:    env.KIBB_CHARTER_PORT ?? D.charterPort,
    commodity:      env.KIBB_COMMODITY ?? D.commodity,
    minMarginPence: env.KIBB_MIN_MARGIN_CR ? Math.round(Number(env.KIBB_MIN_MARGIN_CR) * 100) : D.minMarginPence,
    reservePence:   env.KIBB_RESERVE_CR ? Math.round(Number(env.KIBB_RESERVE_CR) * 100) : D.reservePence,
    dryRun:         env.KIBB_DRY_RUN === "1",
  },
  { onLog: ({ at, msg }) => console.log(`${at} [kibb-charter] ${msg}`) },
);

async function main(): Promise<void> {
  if (runner.cfg.dryRun) {
    await runner.preview();
    console.log("dry run complete");
    return;
  }
  process.on("SIGINT", () => void runner.stop());
  process.on("SIGTERM", () => void runner.stop());
  runner.start();
  await runner.done;
  if (runner.state.status === "failed") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
