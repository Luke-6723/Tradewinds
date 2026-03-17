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

  const toggleDispatch = useCallback(async () => {
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatchEnabled: !(state.dispatchEnabled ?? true) }),
      });
      if (res.ok) setState(await res.json() as AutopilotState);
    } catch { /* ignore */ }
  }, [state.dispatchEnabled]);

  const setFleetTarget = useCallback(async (target: number | null) => {
    try {
      const res = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fleetTarget: target }),
      });
      if (res.ok) setState(await res.json() as AutopilotState);
    } catch { /* ignore */ }
  }, []);

  return { state, toggle, toggleDispatch, toggleFleetMgmt, setFleetTarget };
}

