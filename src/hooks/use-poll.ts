"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data on mount and every `intervalMs` (0 = once). Keeps the last good data on errors.
 * `load` may be null to wait (e.g. until a dependency is known).
 */
export function usePoll<T>(
  load: (() => Promise<T>) | null,
  intervalMs = 0,
  deps: unknown[] = [],
): { data: T | undefined; error: Error | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadRef.current) return;
    setLoading(true);
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, reload, load === null, ...deps]);

  return { data, error, loading, reload };
}
