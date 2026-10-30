/**
 * The autopilot's own progress, saved so a server restart picks up where it left off: each ship's
 * lane and whether its cargo is aboard, the prices it may sell at, trips and stats, purchases, the
 * log, the event cursor and what the world model had learned.
 *
 * With MONGODB_URI set, the snapshot is one document per company in `fleet_snapshots` and every
 * finished trip is appended to `fleet_trips` (the full history; the snapshot keeps only the last
 * few per ship). A copy also goes to `.kibb/fleet-<company>.json`, so the autopilot still resumes
 * when the database is unreachable; on load the newer of the two wins. Writes are folded together
 * (at most one every few seconds) and the file is replaced atomically. A heavy part that can lose a
 * few minutes (JournalPart: the market model's books) is written apart, less often, and put back on
 * load. Server-only.
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
/** Parts written apart (JournalPart), one document per company and part. */
const PARTS_COLLECTION = "fleet_snapshot_parts";
/** What a write leaves where a part goes: `{ [PART_REF]: key }`. */
const PART_REF = "__journalPart";

/**
 * A heavy part of the snapshot that changes all the time but can lose a few minutes on a restart (the market model's books). Put
 * one where the part belongs in what `snapshot` returns: a journal write leaves a reference there and writes the part itself apart
 * (`fleet-<company>.<key>.json`, the `fleet_snapshot_parts` collection), built again only once `everyMs` (real ms) have passed since
 * it was last written, so routine saves neither build nor rewrite it; the final write of a stop or shutdown (Journal.final) writes it
 * whatever the interval. `load` puts the part as last written back in its place (left out when it can't be read). Serialized anywhere
 * else, it is the part itself.
 */
export class JournalPart<P> {
  constructor(
    readonly key: string,
    readonly everyMs: number,
    readonly build: () => P,
  ) {}

  toJSON(): unknown {
    return partWriter ? partWriter(this) : this.build();
  }
}

/** Set for the length of a journal write's (synchronous) JSON.stringify: what a part serializes to then. */
let partWriter: ((p: JournalPart<unknown>) => unknown) | null = null;

interface StoredPart {
  version: number;
  savedAt: string;
  key: string;
  value: unknown;
}

export interface Journal<T> {
  /** The newest snapshot saved for this company, or null (none, unreadable, or another version). */
  load(): Promise<T | null>;
  /** Asks for a write soon; `now` writes at once (after any write in flight). */
  save(now?: boolean): void;
  /** Writes whatever is pending and waits for it. */
  flush(): Promise<void>;
  /**
   * Writes now with every part (JournalPart) built and written afresh whatever its interval, and waits for it: the last save before
   * a stop or shutdown, so a restart loses none of the parts' learning. Not a write barrier for everyday use (flush is).
   */
  final(): Promise<void>;
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
  const base = `fleet-${companyId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const file = path.join(dir, `${base}.json`);
  const partFile = (key: string) => path.join(dir, `${base}.${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  /** When each part was last built for a write (local ms; a failed write forgets it, so the next one tries again). */
  const partAt = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  let pending = false;
  /** A write is queued behind the one in flight and hasn't started: another request rides on it. */
  let queued = false;
  /** The next write to start builds every part afresh (final). */
  let forceParts = false;
  // One failure message per kind until it recovers, so a dead database doesn't flood the log.
  const failing = new Set<string>();
  const report = (kind: string, e: Error) => {
    if (failing.has(kind)) return;
    failing.add(kind);
    onError(new Error(`${kind}: ${e.message}`));
  };

  /** Replaces a file atomically (a temporary file renamed over it). */
  const writeFile = async (f: string, json: string) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, json, { mode: 0o600 });
    await renameOver(tmp, f);
  };

  /** One part written apart: its file and its document. False if either failed. */
  const writePart = async (key: string, json: string): Promise<boolean> => {
    const [inFile, inDb] = await Promise.all([
      (async () => {
        try {
          await writeFile(partFile(key), json);
          failing.delete(`${key} file`);
          return true;
        } catch (e) {
          report(`${key} file`, e as Error);
          return false;
        }
      })(),
      (async () => {
        try {
          const db = mongoDb();
          if (!db) return true;
          await (await db).collection(PARTS_COLLECTION).replaceOne({ _id: `${companyId}|${key}` as never }, { ...JSON.parse(json), companyId }, { upsert: true });
          failing.delete(`${key} database`);
          return true;
        } catch (e) {
          report(`${key} database`, e as Error);
          return false;
        }
      })(),
    ]);
    return inFile && inDb;
  };

  const write = (): Promise<void> => {
    pending = false;
    if (queued) return writing;
    queued = true;
    writing = writing.catch(() => undefined).then(async () => {
      queued = false;
      const all = forceParts;
      forceParts = false;
      let json: string;
      const savedAt = new Date().toISOString();
      // Parts due again (JournalPart; every one for a final write), each built and serialized once, apart.
      const parts: Array<{ key: string; json: string }> = [];
      try {
        partWriter = (p) => {
          const last = partAt.get(p.key);
          if (!parts.some((x) => x.key === p.key) && (all || last === undefined || Date.now() - last >= p.everyMs)) {
            parts.push({ key: p.key, json: JSON.stringify({ version: JOURNAL_VERSION, savedAt, key: p.key, value: p.build() } satisfies StoredPart) });
            partAt.set(p.key, Date.now());
          }
          return { [PART_REF]: p.key };
        };
        // Taken when the write starts, so it carries everything up to now.
        json = JSON.stringify({ version: JOURNAL_VERSION, savedAt, state: snapshot() } satisfies Stored<T>);
      } catch (e) {
        for (const p of parts) partAt.delete(p.key);
        return report("snapshot", e as Error);
      } finally {
        partWriter = null;
      }
      await Promise.all([
        (async () => {
          try {
            await writeFile(file, json);
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
        // A part that failed to write is built and tried again with the next save.
        ...parts.map(async (p) => {
          if (!(await writePart(p.key, p.json))) partAt.delete(p.key);
        }),
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

  /** A part as last written: the newer of its file and database copies (null: neither readable). */
  const readPart = async (key: string): Promise<StoredPart | null> => {
    const [inFile, inDb] = await Promise.all([
      (async () => {
        try {
          return JSON.parse(await fs.readFile(partFile(key), "utf8")) as StoredPart;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") report(`${key} file`, e as Error);
          return null;
        }
      })(),
      (async () => {
        try {
          const db = mongoDb();
          if (!db) return null;
          return ((await (await db).collection(PARTS_COLLECTION).findOne({ _id: `${companyId}|${key}` as never })) as unknown as StoredPart | null) ?? null;
        } catch (e) {
          report(`${key} database`, e as Error);
          return null;
        }
      })(),
    ]);
    const usable = [inFile, inDb].filter((p): p is StoredPart => !!p && p.version === JOURNAL_VERSION && p.key === key && !!p.savedAt && p.value !== undefined);
    usable.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    return usable[0] ?? null;
  };

  /** Puts each part a loaded snapshot refers to back in its place (one that can't be read is left out). */
  const resolveParts = async (state: unknown): Promise<void> => {
    const refs: Array<{ holder: Record<string, unknown>; field: string; key: string }> = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) {
        for (const y of x) walk(y);
        return;
      }
      const o = x as Record<string, unknown>;
      for (const field of Object.keys(o)) {
        const v = o[field];
        if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)[PART_REF] === "string") {
          refs.push({ holder: o, field, key: (v as Record<string, string>)[PART_REF] });
        } else walk(v);
      }
    };
    walk(state);
    const got = new Map<string, Promise<StoredPart | null>>();
    for (const r of refs) {
      if (!got.has(r.key)) got.set(r.key, readPart(r.key));
      const part = await got.get(r.key)!;
      if (part) r.holder[r.field] = part.value;
      else delete r.holder[r.field];
    }
  };

  return {
    async load() {
      const usable = (await Promise.all([readFile(), readDb()])).filter(
        (s): s is Stored<T> => !!s && s.version === JOURNAL_VERSION && !!s.state && !!s.savedAt,
      );
      usable.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
      const state = usable[0]?.state ?? null;
      if (state) await resolveParts(state);
      return state;
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
    async final() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Taken up by the write that starts next: a queued one (not started yet) or a new one behind the one in flight.
      forceParts = true;
      await write();
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
