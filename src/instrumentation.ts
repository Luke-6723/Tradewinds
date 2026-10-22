/** Next.js server start hook: resumes charter runners left enabled by the last server. */
export async function register() {
  // Never trade from `next build` workers, only from a running server.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { resumeRunners } = await import("@/lib/kibb/runner-registry");
    await resumeRunners();
  }
}
