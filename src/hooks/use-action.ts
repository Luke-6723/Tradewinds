"use client";

import { useCallback, useState } from "react";

/**
 * State for a button or form that calls the API: `run(fn)` sets busy, keeps the last result or
 * error message, and calls `onDone` after a success (usually a reload). Returns the result, or
 * undefined if `fn` threw.
 */
export function useAction<T = unknown>(onDone?: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);

  const run = useCallback(
    async (fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const r = await fn();
        setResult(r);
        onDone?.(r);
        return r;
      } catch (e) {
        setError((e as Error).message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { busy, error, result, run, reset };
}
