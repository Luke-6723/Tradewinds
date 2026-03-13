import { runCycle } from "../src/lib/autopilot";
import { blank } from "../src/lib/autopilot-types";

async function main() {
  let s = blank();
  s = { ...s, enabled: true };

  console.log("Running autopilot cycle...\n");
  const result = await runCycle(s, process.env.TRADEWINDS_COMPANY_ID ?? "debug");

  console.log("=== LOG (oldest first) ===");
  for (const entry of [...result.log].reverse()) {
    console.log(entry.at.slice(11, 19), entry.message);
  }
}

main().catch(console.error);
