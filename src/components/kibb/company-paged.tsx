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

/**
 * A list paged by the answer's own `next_cursor` (the Exchange, the bulletin): loads the first page whenever `deps` change,
 * `loadMore()` appends the next. `done` once a page comes back with no cursor.
 */
export function useNextCursorPaged<P extends { next_cursor?: string | null }, T extends { id: string }>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  itemsOf: (page: P) => T[],
  deps: unknown[],
) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const itemsRef = useRef(itemsOf);
  itemsRef.current = itemsOf;
  const generation = useRef(0);

  const load = useCallback(async (cursor: string | undefined) => {
    const gen = generation.current;
    setLoading(true);
    try {
      const page = await fetchRef.current(cursor);
      if (gen !== generation.current) return;
      const rows = itemsRef.current(page);
      setItems((prev) => (cursor ? [...prev, ...rows.filter((x) => !prev.some((y) => y.id === x.id))] : rows));
      setNext(page.next_cursor ?? null);
      setError(null);
    } catch (e) {
      if (gen === generation.current) setError(e as Error);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current++;
    setItems([]);
    setNext(null);
    void load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    items,
    loading,
    error,
    done: next === null,
    loadMore: () => {
      if (next) void load(next);
    },
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
