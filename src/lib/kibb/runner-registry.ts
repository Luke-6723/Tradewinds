/**
 * In-process charter runners, one per company, owned by the Next.js server.
 *
 * The enabled flag and settings persist in the local store, so `resumeRunners()` (called from
 * src/instrumentation.ts at server start) picks up where the last server left off.
 * Server-only.
 */

import {
  CharterRunner,
  DEFAULT_CHARTER_SETTINGS,
  type CharterRunnerState,
  type CharterSettings,
} from "./charter-runner";
import { KIBB_URL } from "./server";
import { getCompanyKey, getStoredRunner, listStoredRunners, saveStoredRunner } from "./store";

// globalThis keeps one registry across Next.js HMR and route bundles.
const g = globalThis as { __kibbRunners?: Map<string, CharterRunner> };
const runners = (g.__kibbRunners ??= new Map<string, CharterRunner>());

export interface RunnerView {
  enabled: boolean;
  settings: CharterSettings;
  state: CharterRunnerState | null;
}

async function settingsFor(companyId: string): Promise<CharterSettings> {
  const stored = await getStoredRunner(companyId);
  return { ...DEFAULT_CHARTER_SETTINGS, ...stored?.settings };
}

async function start(companyId: string, settings: CharterSettings): Promise<void> {
  const key = await getCompanyKey(companyId);
  if (!key) throw new Error("No usable API key stored for this company; select it again on the companies page");
  const previous = runners.get(companyId);
  await previous?.stop();
  const runner = new CharterRunner(
    { ...settings, apiKey: key.apiKey, baseUrl: KIBB_URL },
    {
      onLog: ({ msg }) => console.log(`[charter:${key.companyName}] ${msg}`),
      carryOver: previous?.state,
    },
  );
  runners.set(companyId, runner);
  runner.start();
}

export async function getRunnerView(companyId: string): Promise<RunnerView> {
  const stored = await getStoredRunner(companyId);
  return {
    enabled: stored?.enabled ?? false,
    settings: await settingsFor(companyId),
    state: runners.get(companyId)?.state ?? null,
  };
}

/** Saves the settings patch and the enabled flag, then starts, restarts or stops the runner. */
export async function updateRunner(
  companyId: string,
  change: { enabled?: boolean; settings?: Partial<CharterSettings> },
): Promise<RunnerView> {
  const current = await getRunnerView(companyId);
  const enabled = change.enabled ?? current.enabled;
  const settings = { ...current.settings, ...change.settings };
  await saveStoredRunner(companyId, { enabled, settings });

  const running = runners.get(companyId)?.state.status;
  const isActive = running === "starting" || running === "running";
  if (enabled && (!isActive || change.settings || change.enabled)) {
    await start(companyId, settings);
  } else if (!enabled) {
    await runners.get(companyId)?.stop();
  }
  return getRunnerView(companyId);
}

/** Starts every runner left enabled by the previous server. */
export async function resumeRunners(): Promise<void> {
  for (const r of await listStoredRunners()) {
    if (!r.enabled || runners.has(r.companyId)) continue;
    try {
      await start(r.companyId, { ...DEFAULT_CHARTER_SETTINGS, ...r.settings });
      console.log(`[charter] resumed runner for company ${r.companyId}`);
    } catch (e) {
      console.error(`[charter] could not resume runner for company ${r.companyId}: ${(e as Error).message}`);
    }
  }
}
