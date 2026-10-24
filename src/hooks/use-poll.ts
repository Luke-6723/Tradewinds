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
  // Answers for old deps (bumped on each change) and answers older than one already shown are dropped.
  const gen = useRef(0);
  const seq = useRef(0);
  const shown = useRef(0);

  const reload = useCallback(async () => {
    const fn = loadRef.current;
    if (!fn) return;
    const g = gen.current;
    const s = ++seq.current;
    const current = () => g === gen.current && s > shown.current;
    try {
      const d = await fn();
      if (!current()) return;
      shown.current = s;
      setData(d);
      setError(null);
    } catch (e) {
      if (!current()) return;
      shown.current = s;
      setError(e as Error);
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    gen.current++;
    setError(null);
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
