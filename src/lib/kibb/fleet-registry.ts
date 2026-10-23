/**
 * In-process fleet autopilots, one per company, owned by the Next.js server.
 *
 * The enabled flag and settings persist in the local store, so `resumeFleets()` (called from
 * src/instrumentation.ts at server start) picks up where the last server left off. A lease file
 * (fleet/lease.ts) keeps a second process — another server or the CLI — from running the same
 * company. Changes for one company are serialised. Server-only.
 */

import {
  DEFAULT_FLEET_SETTINGS,
  FleetManager,
  FleetSettingsError,
  sanitizeSettings,
  type FleetSettings,
  type FleetState,
} from "./fleet/manager";
import { KIBB_URL } from "./server";
import { getCompanyKey, getStoredFleet, listStoredFleets, saveStoredFleet, STORE_DIR } from "./store";

// globalThis keeps one registry across Next.js HMR and route bundles.
const g = globalThis as { __kibbFleets?: Map<string, FleetManager>; __kibbFleetLocks?: Map<string, Promise<unknown>> };
const fleets = (g.__kibbFleets ??= new Map<string, FleetManager>());
const locks = (g.__kibbFleetLocks ??= new Map<string, Promise<unknown>>());

export { FleetSettingsError };

export interface FleetView {
  enabled: boolean;
  settings: FleetSettings;
  state: FleetState | null;
}

/** Runs `fn` after any earlier change for this company has finished. */
function serial<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(companyId) ?? Promise.resolve()).then(fn);
  locks.set(companyId, run.catch(() => undefined));
  return run;
}

async function settingsFor(companyId: string): Promise<FleetSettings> {
  const stored = await getStoredFleet(companyId);
  return { ...DEFAULT_FLEET_SETTINGS, ...sanitizeQuiet(stored?.settings ?? {}) };
}

/** Stored settings from an older version may not validate: drop what doesn't. */
function sanitizeQuiet(s: Partial<FleetSettings>): Partial<FleetSettings> {
  const out: Partial<FleetSettings> = {};
  for (const [k, v] of Object.entries(s)) {
    try {
      Object.assign(out, sanitizeSettings({ [k]: v } as Partial<FleetSettings>));
    } catch {
      // ignore the bad field
    }
  }
  return out;
}

async function start(companyId: string, settings: FleetSettings): Promise<void> {
  const key = await getCompanyKey(companyId);
  if (!key) throw new Error("No usable API key stored for this company; select it again on the companies page");
  const previous = fleets.get(companyId);
  await previous?.stop();
  const manager = new FleetManager(
    { apiKey: key.apiKey, baseUrl: KIBB_URL, settings, leaseDir: STORE_DIR },
    {
      onLog: ({ source, msg }) => console.log(`[fleet:${key.companyName}] ${source}: ${msg}`),
      carryOver: previous?.state,
    },
  );
  fleets.set(companyId, manager);
  manager.start();
}

function isActive(m: FleetManager | undefined): boolean {
  const s = m?.state.status;
  return s === "starting" || s === "running";
}

export async function getFleetView(companyId: string): Promise<FleetView> {
  const stored = await getStoredFleet(companyId);
  return {
    enabled: stored?.enabled ?? false,
    settings: await settingsFor(companyId),
    state: fleets.get(companyId)?.state ?? null,
  };
}

/**
 * Validates and saves a settings patch and the enabled flag, then starts or stops the autopilot.
 * Settings apply live. Throws FleetSettingsError on invalid input.
 */
export function updateFleet(
  companyId: string,
  change: { enabled?: boolean; settings?: Partial<FleetSettings> },
): Promise<FleetView> {
  return serial(companyId, async () => {
    if (change.enabled !== undefined && typeof change.enabled !== "boolean") throw new FleetSettingsError("enabled must be true or false");
    const patch = sanitizeSettings(change.settings ?? {});
    const current = await getFleetView(companyId);
    const enabled = change.enabled ?? current.enabled;
    const settings = { ...current.settings, ...patch };

    const manager = fleets.get(companyId);
    if (enabled && !isActive(manager)) {
      // Never record "enabled" without a key to run on.
      if (!(await getCompanyKey(companyId))) {
        throw new Error("No usable API key stored for this company; select it again on the companies page");
      }
      await saveStoredFleet(companyId, { enabled, settings });
      await start(companyId, settings);
    } else {
      await saveStoredFleet(companyId, { enabled, settings });
      if (!enabled && manager) await manager.stop();
      else if (manager) manager.settings = settings;
    }
    return getFleetView(companyId);
  });
}

/**
 * Restarts the autopilot on the company's newest stored key (called after a key is minted): a
 * running one, or an enabled one that failed (typically on the old key's 401).
 */
export function refreshFleetKey(companyId: string): Promise<void> {
  return serial(companyId, async () => {
    const m = fleets.get(companyId);
    const enabled = (await getStoredFleet(companyId))?.enabled ?? false;
    if (!isActive(m) && !(enabled && m?.state.status === "failed")) return;
    await start(companyId, await settingsFor(companyId));
  });
}

/** Starts every autopilot left enabled by the previous server. */
export async function resumeFleets(): Promise<void> {
  for (const f of await listStoredFleets()) {
    if (!f.enabled) continue;
    await serial(f.companyId, async () => {
      if (isActive(fleets.get(f.companyId))) return;
      try {
        await start(f.companyId, { ...DEFAULT_FLEET_SETTINGS, ...sanitizeQuiet(f.settings) });
        console.log(`[fleet] resumed autopilot for company ${f.companyId}`);
      } catch (e) {
        console.error(`[fleet] could not resume autopilot for company ${f.companyId}: ${(e as Error).message}`);
      }
    });
  }
}
