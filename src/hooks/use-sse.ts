"use client";

import { useEffect, useRef, useState } from "react";

export function useSse<T = unknown>(url: string, enabled = true) {
  const [events, setEvents] = useState<T[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as T;
        setEvents((prev) => [parsed, ...prev].slice(0, 100));
      } catch {
        // non-JSON message, store as-is
        setEvents((prev) => [e.data as T, ...prev].slice(0, 100));
      }
    };

    es.onerror = () => {
      setConnected(false);
      setError("SSE connection lost");
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [url, enabled]);

  const clear = () => setEvents([]);

  return { events, connected, error, clear };
}
