"use client";

import { useCallback, useEffect, useState } from "react";
import { blank, type AutopilotState } from "@/lib/autopilot-types";

import { CYCLE_MS } from "@/lib/autopilot-types";

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
    const id = setInterval(() => void fetchState(), CYCLE_MS);
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

  const toggleFleetMgmt = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fleetMgmt: !state.fleetMgmt?.enabled }),
      });
      if (res.ok) setState(await res.json() as AutopilotState);
    } catch { /* ignore */ }
  }, [state.fleetMgmt?.enabled]);

  return { state, toggle, toggleFleetMgmt };
}

