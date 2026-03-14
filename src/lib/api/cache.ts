/**
 * Lightweight localStorage cache with TTL.
 * All keys are prefixed with "tw_cache_" so they can be cleared in bulk.
 * Silently no-ops on the server (SSR) or when localStorage is unavailable.
 */

const PREFIX = "tw_cache_";

interface CacheEntry<T> {
  data: T;
  expiresAt: number; // epoch ms
}

function storageKey(key: string): string {
  return PREFIX + key;
}

/** Return cached value if present and not expired, otherwise null. */
export function getCached<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) {
      localStorage.removeItem(storageKey(key));
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

/** Store a value in cache with a TTL in milliseconds. */
export function setCached<T>(key: string, data: T, ttlMs: number): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CacheEntry<T> = { data, expiresAt: Date.now() + ttlMs };
    localStorage.setItem(storageKey(key), JSON.stringify(entry));
  } catch {
    // localStorage may be full or unavailable — ignore
  }
}

/**
 * Invalidate a specific cache key, or all tw_cache_* entries when called
 * with no argument.
 */
export function invalidateCache(key?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (key !== undefined) {
      localStorage.removeItem(storageKey(key));
      return;
    }
    // Clear all tw_cache_* entries
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}
