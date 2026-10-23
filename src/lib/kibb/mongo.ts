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
