"use client";

import { useCallback, useEffect, useState } from "react";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

const POLL_MS = 3_000;

export function useAutopilot() {
  const [state, setState] = useState<AutopilotState>(blank);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", { cache: "no-store" });
      if (res.ok) setState(await res.json() as AutopilotState);
    } catch { /* ignore network errors */ }
  }, []);

  useEffect(() => {
    void fetchState();
    const id = setInterval(() => void fetchState(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchState]);

  const toggle = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      if (res.ok) setState(await res.json() as AutopilotState);
    } catch { /* ignore */ }
  }, [state.enabled]);

  return { state, toggle };
}

