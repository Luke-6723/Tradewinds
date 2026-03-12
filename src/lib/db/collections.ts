/**
 * Typed MongoDB collection helpers.
 *
 * Collections:
 *   events          – SSE events (world + per-company), capped at 500 per scope
 *   autopilot_states – one doc per company, stores the full AutopilotState
 */

import { getDb } from "./mongodb";
import type { AutopilotState } from "@/lib/autopilot-types";
import type { Filter } from "mongodb";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredEvent {
  scope: "world" | "company";
  companyId?: string;
  /** Raw parsed event payload */
  // biome-ignore lint/suspicious/noExplicitAny: open-ended event shape
  data: Record<string, any>;
  receivedAt: Date;
}

export interface StoredAutopilotState {
  companyId: string;
  state: AutopilotState;
  updatedAt: Date;
}

// ── Events ────────────────────────────────────────────────────────────────────

const MAX_EVENTS = 500;

export async function saveEvent(event: Omit<StoredEvent, "receivedAt">): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const col = db.collection<StoredEvent>("events");
  await col.insertOne({ ...event, receivedAt: new Date() });

  // keep only the most recent MAX_EVENTS per scope
  const filter: Filter<StoredEvent> = event.companyId
    ? { scope: "company", companyId: event.companyId }
    : { scope: "world" };
  const count = await col.countDocuments(filter);
  if (count > MAX_EVENTS) {
    const oldest = await col
      .find(filter)
      .sort({ receivedAt: 1 })
      .limit(count - MAX_EVENTS)
      .toArray();
    if (oldest.length) {
      await col.deleteMany({ _id: { $in: oldest.map((d) => d._id!) } });
    }
  }
}

export async function getEvents(
  scope: "world" | "company",
  companyId?: string,
  limit = 100,
): Promise<StoredEvent[]> {
  const db = await getDb();
  if (!db) return [];

  const filter: Filter<StoredEvent> = companyId
    ? { scope: "company", companyId }
    : { scope: "world" };
  return db
    .collection<StoredEvent>("events")
    .find(filter)
    .sort({ receivedAt: -1 })
    .limit(limit)
    .toArray();
}

// ── Autopilot state ────────────────────────────────────────────────────────────

export async function saveAutopilotState(
  companyId: string,
  state: AutopilotState,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db.collection<StoredAutopilotState>("autopilot_states").updateOne(
    { companyId },
    { $set: { companyId, state, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function loadAutopilotState(
  companyId: string,
): Promise<AutopilotState | null> {
  const db = await getDb();
  if (!db) return null;

  const doc = await db
    .collection<StoredAutopilotState>("autopilot_states")
    .findOne({ companyId });
  return doc?.state ?? null;
}
