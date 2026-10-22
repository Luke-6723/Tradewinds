/**
 * Local JSON store for the dashboard: company-bound API keys and charter-runner settings.
 *
 * Lives in `.kibb/store.json` under the project root (gitignored), or KIBB_STORE_DIR.
 * Passphrases are never stored; company keys are, so the runner can trade while no browser is open.
 * Server-only (uses node:fs).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CharterSettings } from "./charter-runner";

const STORE_DIR  = process.env.KIBB_STORE_DIR ?? path.join(process.cwd(), ".kibb");
const STORE_FILE = path.join(STORE_DIR, "store.json");

export interface StoredCompanyKey {
  companyId: string;
  companyName: string;
  apiKey: string;
  keyId: string;
  expiresAt: string | null;
  savedAt: string;
}

export interface StoredRunner {
  enabled: boolean;
  settings: CharterSettings;
  updatedAt: string;
}

interface StoreData {
  companies: Record<string, StoredCompanyKey>;
  runners: Record<string, StoredRunner>;
}

// One write queue per process, shared across Next.js module instances.
const g = globalThis as { __kibbStoreQueue?: Promise<unknown> };

async function read(): Promise<StoreData> {
  try {
    const data = JSON.parse(await fs.readFile(STORE_FILE, "utf8")) as Partial<StoreData>;
    return { companies: data.companies ?? {}, runners: data.runners ?? {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { companies: {}, runners: {} };
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
    await fs.rename(tmp, STORE_FILE);
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

// ── Runner settings ───────────────────────────────────────────────────────────

export async function getStoredRunner(companyId: string): Promise<StoredRunner | null> {
  return (await read()).runners[companyId] ?? null;
}

export async function saveStoredRunner(companyId: string, runner: Omit<StoredRunner, "updatedAt">): Promise<void> {
  await update((d) => {
    d.runners[companyId] = { ...runner, updatedAt: new Date().toISOString() };
  });
}

export async function listStoredRunners(): Promise<Array<StoredRunner & { companyId: string }>> {
  return Object.entries((await read()).runners).map(([companyId, r]) => ({ companyId, ...r }));
}
