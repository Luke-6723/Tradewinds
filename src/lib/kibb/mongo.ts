/**
 * The MongoDB connection (MONGODB_URI), shared across Next.js module instances and the CLI. The
 * database is the one named in the URI, else MONGODB_DB, else "tradewinds". Server-only.
 */

import { MongoClient, type Db } from "mongodb";

const g = globalThis as { __kibbMongo?: Promise<Db> | null };

/** True when a MongoDB URI is configured. */
export function mongoConfigured(): boolean {
  return !!process.env.MONGODB_URI;
}

function dbName(uri: string): string {
  // Read by hand: a URI with several hosts isn't a WHATWG URL.
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?#]*)/.exec(uri);
  let name = "";
  try {
    name = m?.[1] ? decodeURIComponent(m[1]) : "";
  } catch {
    name = "";
  }
  return name || process.env.MONGODB_DB || "tradewinds";
}

/**
 * Runs `op` on the database, rejecting when it hasn't finished within `ms` (connecting included), so a hung
 * connection never holds the caller up; rejects too when no URI is configured. What `op` sent may still land later.
 */
export async function mongoWithin<T>(ms: number, op: (db: Db) => Promise<T>): Promise<T> {
  const db = mongoDb();
  if (!db) throw new Error("no database configured");
  const run = db.then(op);
  // A late failure, after the time ran out, is nobody's to handle.
  run.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the database in ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The database, connecting on first use; null when no URI is configured. A failed connect is retried next call. */
export function mongoDb(): Promise<Db> | null {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!g.__kibbMongo) {
    // Built inside the promise: a URI the driver can't parse becomes a rejection, not a throw.
    g.__kibbMongo = (async () => {
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, appName: "tradewinds-dashboard" });
      await client.connect();
      return client.db(dbName(uri));
    })().catch((e) => {
      g.__kibbMongo = null;
      throw e;
    });
  }
  return g.__kibbMongo;
}
