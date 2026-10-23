/**
 * Next.js server start hook: resumes fleet autopilots left enabled by the last server, and on
 * SIGINT/SIGTERM saves their progress before exiting. For the save to finish first, run with
 * NEXT_MANUAL_SIG_HANDLE=true (ecosystem.config.cjs sets it); otherwise Next.js exits at once and
 * only the last periodic save survives.
 */
export async function register() {
  // Never trade from `next build` workers, only from a running server.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { resumeFleets, shutdownFleets } = await import("@/lib/kibb/fleet-registry");
    let leaving = false;
    const bye = (signal: string) => {
      if (leaving) return;
      leaving = true;
      console.log(`[fleet] ${signal}: saving autopilot progress before exit`);
      void shutdownFleets(8_000).finally(() => process.exit(0));
    };
    process.once("SIGINT", () => bye("SIGINT"));
    process.once("SIGTERM", () => bye("SIGTERM"));
    await resumeFleets();
  }
}
