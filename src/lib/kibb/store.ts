/**
 * Local JSON store for the dashboard: company-bound API keys and fleet-autopilot settings.
 *
 * Lives in `.kibb/store.json` under the project root (gitignored), or KIBB_STORE_DIR.
 * Passphrases are never stored; company keys are, so the autopilot can trade while no browser is open.
 * Server-only (uses node:fs).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FleetSettings } from "./fleet/manager";

export const STORE_DIR = process.env.KIBB_STORE_DIR ?? path.join(process.cwd(), ".kibb");
const STORE_FILE = path.join(STORE_DIR, "store.json");

export interface StoredCompanyKey {
  companyId: string;
  companyName: string;
  apiKey: string;
  keyId: string;
  expiresAt: string | null;
  savedAt: string;
}

export interface StoredFleet {
  enabled: boolean;
  settings: Partial<FleetSettings>;
  updatedAt: string;
}

interface StoreData {
  companies: Record<string, StoredCompanyKey>;
  fleets: Record<string, StoredFleet>;
  /** Pre-fleet single charter runner; only its enabled flag is carried over. */
  runners?: Record<string, { enabled: boolean }>;
}

/**
 * Renames `from` over `to`, retrying briefly: on Windows a rename onto a file another handle has
 * open fails with EPERM/EACCES/EBUSY until that handle closes.
 */
export async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(code)) {
        await fs.unlink(from).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20 + attempt * 10));
    }
  }
}

// One write queue per process, shared across Next.js module instances.
const g = globalThis as { __kibbStoreQueue?: Promise<unknown> };

async function read(): Promise<StoreData> {
  try {
    const data = JSON.parse(await fs.readFile(STORE_FILE, "utf8")) as Partial<StoreData>;
    return { companies: data.companies ?? {}, fleets: data.fleets ?? {}, runners: data.runners };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { companies: {}, fleets: {} };
    throw e;
  }
}

/** Serialised read-modify-write; writes via a temp file so a crash never leaves half a file. */
function update(fn: (data: StoreData) => void): Promise<StoreData> {
  const next = (g.__kibbStoreQueue ?? Promise.resolve()).then(async () => {
    const data = await read();
    fn(data);
    await fs.mkdir(STORE_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await renameOver(tmp, STORE_FILE);
    return data;
  });
  g.__kibbStoreQueue = next.catch(() => undefined);
  return next;
}

/** True when the key has at least `marginMs` of life left. */
export function keyIsUsable(key: StoredCompanyKey, marginMs = 60_000): boolean {
  return !key.expiresAt || Date.parse(key.expiresAt) - Date.now() > marginMs;
}

// ── Company keys ──────────────────────────────────────────────────────────────

/** The stored key for a company, or null when missing or expired. */
export async function getCompanyKey(companyId: string): Promise<StoredCompanyKey | null> {
  const key = (await read()).companies[companyId];
  return key && keyIsUsable(key) ? key : null;
}

export async function saveCompanyKey(key: StoredCompanyKey): Promise<void> {
  await update((d) => {
    d.companies[key.companyId] = key;
  });
}

export async function listCompanyKeys(): Promise<StoredCompanyKey[]> {
  return Object.values((await read()).companies);
}

// ── Fleet autopilot ───────────────────────────────────────────────────────────

export async function getStoredFleet(companyId: string): Promise<StoredFleet | null> {
  const d = await read();
  const legacy = d.runners?.[companyId];
  return d.fleets[companyId] ?? (legacy ? { enabled: legacy.enabled, settings: {}, updatedAt: "" } : null);
}

export async function saveStoredFleet(companyId: string, fleet: Omit<StoredFleet, "updatedAt">): Promise<void> {
  await update((d) => {
    d.fleets[companyId] = { ...d.fleets[companyId], ...fleet, updatedAt: new Date().toISOString() };
    if (d.runners) delete d.runners[companyId];
  });
}

export async function listStoredFleets(): Promise<Array<StoredFleet & { companyId: string }>> {
  const d = await read();
  const ids = new Set([...Object.keys(d.fleets), ...Object.keys(d.runners ?? {})]);
  const out: Array<StoredFleet & { companyId: string }> = [];
  for (const companyId of ids) {
    const f = d.fleets[companyId] ?? { enabled: d.runners?.[companyId]?.enabled ?? false, settings: {}, updatedAt: "" };
    out.push({ companyId, ...f });
  }
  return out;
}
