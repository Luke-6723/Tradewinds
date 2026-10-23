/**
 * The autopilot's own progress, saved so a server restart picks up where it left off: each ship's
 * lane and whether its cargo is aboard, the prices it may sell at, trips and stats, purchases, the
 * log, the event cursor and what the world model had learned.
 *
 * With MONGODB_URI set, the snapshot is one document per company in `fleet_snapshots` and every
 * finished trip is appended to `fleet_trips` (the full history; the snapshot keeps only the last
 * few per ship). A copy also goes to `.kibb/fleet-<company>.json`, so the autopilot still resumes
 * when the database is unreachable; on load the newer of the two wins. Writes are folded together
 * (at most one every few seconds) and the file is replaced atomically. Server-only.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { mongoDb } from "../mongo";
import { renameOver } from "../store";

/** Bumped when the shape changes incompatibly: an older snapshot is then ignored. */
export const JOURNAL_VERSION = 1;
/**
 * Most often a routine save is written (a burst of changes is folded into one write). Trips,
 * loads, deliveries and buyer actions save at once.
 */
const MIN_INTERVAL_MS = 15_000;

export interface Journal<T> {
  /** The newest snapshot saved for this company, or null (none, unreadable, or another version). */
  load(): Promise<T | null>;
  /** Asks for a write soon; `now` writes at once (after any write in flight). */
  save(now?: boolean): void;
  /** Writes whatever is pending and waits for it. */
  flush(): Promise<void>;
  /** Appends one finished trip to the history (database only). */
  recordTrip(trip: Record<string, unknown>): void;
}

interface Stored<T> {
  version: number;
  savedAt: string;
  state: T;
}

/**
 * A journal for one company. `snapshot` is called at write time, so a write always carries the
 * latest state; failures go to `onError` (which must not ask for another save) and the next save
 * tries again.
 */
export function openJournal<T>(dir: string, companyId: string, snapshot: () => T, onError: (e: Error) => void): Journal<T> {
  const file = path.join(dir, `fleet-${companyId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  let pending = false;
  /** A write is queued behind the one in flight and hasn't started: another request rides on it. */
  let queued = false;
  // One failure message per kind until it recovers, so a dead database doesn't flood the log.
  const failing = new Set<string>();
  const report = (kind: string, e: Error) => {
    if (failing.has(kind)) return;
    failing.add(kind);
    onError(new Error(`${kind}: ${e.message}`));
  };

  const write = (): Promise<void> => {
    pending = false;
    if (queued) return writing;
    queued = true;
    writing = writing.catch(() => undefined).then(async () => {
      queued = false;
      let json: string;
      try {
        // Taken when the write starts, so it carries everything up to now.
        json = JSON.stringify({ version: JOURNAL_VERSION, savedAt: new Date().toISOString(), state: snapshot() } satisfies Stored<T>);
      } catch (e) {
        return report("snapshot", e as Error);
      }
      await Promise.all([
        (async () => {
          try {
            await fs.mkdir(dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(tmp, json, { mode: 0o600 });
            await renameOver(tmp, file);
            failing.delete("file");
          } catch (e) {
            report("file", e as Error);
          }
        })(),
        (async () => {
          try {
            const db = mongoDb();
            if (!db) return;
            // Stored as parsed JSON, so the document holds exactly what the file does.
            await (await db).collection("fleet_snapshots").replaceOne({ _id: companyId as never }, { ...JSON.parse(json), companyId }, { upsert: true });
            failing.delete("database");
          } catch (e) {
            report("database", e as Error);
          }
        })(),
      ]);
      lastWrite = Date.now();
    });
    return writing;
  };

  const readFile = async (): Promise<Stored<T> | null> => {
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as Stored<T>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") report("file", e as Error);
      return null;
    }
  };
  const readDb = async (): Promise<Stored<T> | null> => {
    try {
      const db = mongoDb();
      if (!db) return null;
      return ((await (await db).collection("fleet_snapshots").findOne({ _id: companyId as never })) as unknown as Stored<T> | null) ?? null;
    } catch (e) {
      report("database", e as Error);
      return null;
    }
  };

  return {
    async load() {
      const usable = (await Promise.all([readFile(), readDb()])).filter(
        (s): s is Stored<T> => !!s && s.version === JOURNAL_VERSION && !!s.state && !!s.savedAt,
      );
      usable.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
      return usable[0]?.state ?? null;
    },
    save(now = false) {
      if (now) {
        if (timer) clearTimeout(timer);
        timer = null;
        void write();
        return;
      }
      if (pending) return;
      pending = true;
      const wait = Math.max(0, lastWrite + MIN_INTERVAL_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        void write();
      }, wait);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) await write();
      else await writing;
    },
    recordTrip(trip) {
      let db: ReturnType<typeof mongoDb>;
      try {
        db = mongoDb();
      } catch (e) {
        return report("trip history", e as Error);
      }
      if (!db) return;
      void db
        .then((d) => d.collection("fleet_trips").insertOne({ companyId, ...trip, savedAt: new Date() }))
        .then(() => failing.delete("trip history"))
        .catch((e) => report("trip history", e as Error));
    },
  };
}
