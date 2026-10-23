"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A cursor-paged list (`cursor` = last item's id): loads the first page whenever `deps` change,
 * `loadMore()` appends the next. `done` once a page comes back short.
 */
export function usePaged<T extends { id: string }>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<T[]>,
  deps: unknown[],
  limit = 50,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const generation = useRef(0);

  const load = useCallback(
    async (cursor: string | undefined) => {
      const gen = generation.current;
      setLoading(true);
      try {
        const page = await fetchRef.current(cursor, limit);
        if (gen !== generation.current) return;
        setItems((prev) => (cursor ? [...prev, ...page] : page));
        setDone(page.length < limit);
        setError(null);
      } catch (e) {
        if (gen === generation.current) setError(e as Error);
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [limit],
  );

  useEffect(() => {
    generation.current++;
    setItems([]);
    setDone(false);
    void load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    items,
    loading,
    error,
    done,
    loadMore: () => void load(items.at(-1)?.id),
    reload: () => {
      generation.current++;
      void load(undefined);
    },
  };
}

export function LoadMore({ loading, done, onClick, count }: { loading: boolean; done: boolean; onClick: () => void; count: number }) {
  if (done && count === 0) return null;
  return (
    <div className="flex items-center justify-between pt-3 text-muted-foreground text-xs">
      <span>{count} shown</span>
      {!done && (
        <Button size="sm" variant="outline" disabled={loading} onClick={onClick}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
