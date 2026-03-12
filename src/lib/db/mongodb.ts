/**
 * MongoDB connection singleton.
 *
 * Reuses the same MongoClient across Next.js hot reloads and worker processes.
 * Set MONGODB_URI in your environment to enable persistence; if the variable
 * is absent every operation is a no-op so the app still works without Mongo.
 */

import { MongoClient, type Db } from "mongodb";

const URI = process.env.MONGODB_URI ?? "";

// globalThis cache keeps a single client across Next.js HMR module reloads
const g = globalThis as { __mongoClient?: MongoClient };

export async function getDb(): Promise<Db | null> {
  if (!URI) return null;

  if (!g.__mongoClient) {
    g.__mongoClient = new MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
  }

  try {
    // connect() is idempotent — safe to call multiple times
    await g.__mongoClient.connect();
    return g.__mongoClient.db();
  } catch (err) {
    console.error("[mongodb] connection failed:", err);
    return null;
  }
}
