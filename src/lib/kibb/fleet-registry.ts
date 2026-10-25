/**
 * In-process fleet autopilots, one per company, owned by the Next.js server.
 *
 * The enabled flag and settings persist in the local store, so `resumeFleets()` (called from
 * src/instrumentation.ts at server start) picks up where the last server left off. A lease
 * (fleet/lease.ts: a file, and with MONGODB_URI a database document for other machines) keeps a
 * second process — another server or the CLI — from running the same company. Changes for one
 * company are serialised. Server-only.
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
import { getCompanyKey, getStoredFleet, listCompanyKeys, listStoredFleets, saveStoredFleet, STORE_DIR } from "./store";

// globalThis keeps one registry across Next.js HMR and route bundles.
const g = globalThis as {
  __kibbFleets?: Map<string, FleetManager>;
  __kibbFleetLocks?: Map<string, Promise<unknown>>;
  __kibbResumeErrors?: Map<string, { at: string; error: string }>;
};
const fleets = (g.__kibbFleets ??= new Map<string, FleetManager>());
const locks = (g.__kibbFleetLocks ??= new Map<string, Promise<unknown>>());
/** Why an enabled autopilot couldn't be resumed at server start, until one is started for the company. */
const resumeErrors = (g.__kibbResumeErrors ??= new Map<string, { at: string; error: string }>());

export { FleetSettingsError };

export interface FleetView {
  enabled: boolean;
  settings: FleetSettings;
  state: FleetState | null;
  /** When the stored company key expires (null: never, or none stored): shown even while the autopilot is stopped. */
  keyExpiresAt: string | null;
  /** The autopilot was enabled but couldn't be resumed when the server started. */
  resumeError: { at: string; error: string } | null;
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
  resumeErrors.delete(companyId);
}

function isActive(m: FleetManager | undefined): boolean {
  const s = m?.state.status;
  return s === "starting" || s === "running";
}

export async function getFleetView(companyId: string): Promise<FleetView> {
  const stored = await getStoredFleet(companyId);
  const key = (await listCompanyKeys()).find((k) => k.companyId === companyId);
  return {
    enabled: stored?.enabled ?? false,
    settings: await settingsFor(companyId),
    state: fleets.get(companyId)?.state ?? null,
    keyExpiresAt: key?.expiresAt ?? null,
    resumeError: resumeErrors.get(companyId) ?? null,
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
      // A stopped one too: its AI panel then shows the mode just chosen.
      if (manager) manager.settings = settings;
    }
    return getFleetView(companyId);
  });
}

/**
 * The AI strategist: ask it now (the autopilot must be running), clear its directives, or retry
 * live after it demoted itself (those two work on a stopped autopilot too, and are saved).
 */
export function aiCommand(companyId: string, cmd: "run" | "clear" | "retry"): Promise<FleetView> {
  return serial(companyId, async () => {
    const m = fleets.get(companyId);
    if (!m) throw new Error("The autopilot hasn't run since the server started");
    if (cmd === "run" && !isActive(m)) throw new Error("The autopilot isn't running");
    m.aiCommand(cmd);
    return getFleetView(companyId);
  });
}

/**
 * Puts the autopilot on the company's newest stored key (called after a key is minted): a running one
 * switches to it without a restart; an enabled one that failed (typically on the old key's 401), or that
 * couldn't be resumed at server start, starts again on it.
 */
export function refreshFleetKey(companyId: string): Promise<void> {
  return serial(companyId, async () => {
    const m = fleets.get(companyId);
    const key = await getCompanyKey(companyId);
    if (m && isActive(m) && key) {
      try {
        await m.useApiKey(key.apiKey);
        return;
      } catch (e) {
        console.error(`[fleet] company ${companyId}: switching to the new key failed (${(e as Error).message}); restarting on it`);
      }
    }
    const enabled = (await getStoredFleet(companyId))?.enabled ?? false;
    if (!isActive(m) && !(enabled && (m?.state.status === "failed" || (!m && resumeErrors.has(companyId))))) return;
    await start(companyId, await settingsFor(companyId));
  });
}

/**
 * What an autopilot has seen of rival ships, its last letter-of-marque report, and (running) its
 * rival intel: snapshot, last analysis, hull quotes.
 */
export function fleetRivals(companyId: string) {
  const m = fleets.get(companyId);
  // A stopped autopilot's report would be stale: only a running one's, checked lately, counts.
  const st = m?.state;
  const live = st && (st.status === "running" || st.status === "starting");
  const report = live && st.marques && Date.now() - Date.parse(st.marques.checkedAt) < 12 * 60_000 ? st.marques : null;
  const intel = m?.rivalIntel;
  return { sightings: intel?.sightings ?? [], report, intel: live ? (intel ?? null) : null };
}

/**
 * Server shutdown: saves every autopilot's progress at once, then gives them up to `graceMs` to
 * stop cleanly (finish the call in flight, release the lease) before the process exits.
 */
export async function shutdownFleets(graceMs: number): Promise<void> {
  const all = [...fleets.values()];
  await Promise.allSettled(all.map((m) => m.flush()));
  await Promise.race([Promise.allSettled(all.map((m) => m.stop())), new Promise((r) => setTimeout(r, graceMs))]);
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
        // Shown on the panel until it is started again.
        resumeErrors.set(f.companyId, { at: new Date().toISOString(), error: (e as Error).message });
      }
    });
  }
}
