/**
 * Per-company lease so only one process (dashboard server or CLI) runs a company's autopilot.
 *
 * On this machine, `fleet-<companyId>.lock` holds {pid, host, id, beat}; the holder rewrites `beat` every 30 s
 * (atomically, via rename) and removes the file on release. A lease whose beat is stale, or whose
 * pid is dead on this host, may be taken over; takeover renames the old file away first, so of two
 * racers only one wins.
 *
 * Across machines (MONGODB_URI set) a document per company in `fleet_leases` must be ours too: claimed
 * only while it is free (its beat STALE_MS old by the database's own clock) or already ours, and renewed
 * with every beat. The database never holds start-up up past DB_TIMEOUT_MS: out of reach, the file alone
 * holds, and the document is claimed at the first beat that reaches it (lost there if another process
 * has it by then). A holder that finds either lease gone or taken calls `onLost`. Server-only.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Filter } from "mongodb";
import { mongoConfigured, mongoWithin } from "../mongo";
import { renameOver } from "../store";

const BEAT_MS = 30_000;
const STALE_MS = 90_000;
/** Consecutive failed heartbeats before the holder gives the lease up. */
const MAX_BEAT_FAILURES = 2;
/** Longest a database lease call may take, connecting included: past it the database counts as out of reach. */
const DB_TIMEOUT_MS = 8_000;
const DB_LEASES = "fleet_leases";

interface LeaseBody {
  pid: number;
  host: string;
  id: string;
  beat: number;
}

/** The database lease; `beat` is the database's own time at the last claim or renewal. */
interface DbLease {
  _id: string;
  pid: number;
  host: string;
  id: string;
  beat: Date;
}

/** The database side of a lease: whose it is, whether the database was out of reach at the last try, and where changes are said. */
interface DbSide {
  companyId: string;
  down: boolean;
  note?: (msg: string) => void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function read(file: string): Promise<LeaseBody | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as LeaseBody;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, body: LeaseBody): Promise<void> {
  const tmp = `${file}.${body.id}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body));
  await renameOver(tmp, file);
}

/**
 * Claims the company's database lease for `body`, or renews it: only while it is this lease's, or (at start-up)
 * the one `freed` names: the lease whose file this start just took over (a process of this same store dir that is
 * gone, or this process before, as only the file lease can judge: a hostname may be another machine's too, and a
 * pid there can't be looked at from here), or its beat is STALE_MS old by the database's clock, so hosts whose
 * clocks disagree still agree on that. Each claim is one findOneAndUpdate, so of two racing for a free one only one
 * wins. Null: ours now; else who holds it. Rejects when the database doesn't answer in time.
 */
function claimDb(companyId: string, body: LeaseBody, freed: string | null): Promise<{ heldBy: string } | null> {
  return mongoWithin(DB_TIMEOUT_MS, async (db) => {
    const leases = db.collection<DbLease>(DB_LEASES);
    const take = (filter: Filter<DbLease>) =>
      leases.findOneAndUpdate({ _id: companyId, ...filter }, { $set: { pid: body.pid, host: body.host, id: body.id }, $currentDate: { beat: true } });
    const ours: Filter<DbLease>[] = freed ? [{ id: body.id }, { id: freed }] : [{ id: body.id }];
    const claim = () => take({ $or: [...ours, { $expr: { $lt: ["$beat", { $subtract: ["$$NOW", STALE_MS] }] } }] });
    if (await claim()) return null;
    let cur = await leases.findOne({ _id: companyId });
    if (!cur) {
      // None yet for this company: a free one is made, then claimed like any other.
      await leases.insertOne({ _id: companyId, pid: 0, host: "", id: "", beat: new Date(0) }).catch((e: unknown) => {
        if ((e as { code?: unknown }).code !== 11000) throw e;
      });
      if (await claim()) return null;
      cur = await leases.findOne({ _id: companyId });
    }
    return { heldBy: cur ? `pid ${cur.pid} on ${cur.host}` : "another process" };
  });
}

export class Lease {
  private readonly timer: ReturnType<typeof setInterval>;
  private beating: Promise<void> = Promise.resolve();
  private busy = false;
  private failures = 0;
  private lost = false;

  constructor(
    private readonly file: string,
    private readonly body: LeaseBody,
    private readonly onLost: () => void,
    /** With MONGODB_URI set; null: the file alone. */
    private readonly db: DbSide | null,
  ) {
    this.timer = setInterval(() => {
      // One beat at a time: a slow database call never stacks another behind it.
      if (this.busy) return;
      this.busy = true;
      this.beating = this.beat().finally(() => {
        this.busy = false;
      });
    }, BEAT_MS);
    this.timer.unref?.();
  }

  private async beat(): Promise<void> {
    if (this.lost) return;
    const cur = await read(this.file);
    if (cur && cur.id !== this.body.id) return this.lose();
    try {
      await writeAtomic(this.file, { ...this.body, beat: Date.now() });
      this.failures = 0;
    } catch {
      if (++this.failures >= MAX_BEAT_FAILURES) return this.lose();
    }
    if (this.db) await this.beatDb(this.db);
  }

  /** Renews the database lease. Taken meanwhile (while it was out of reach, or by a newer start in this process): lost. */
  private async beatDb(db: DbSide): Promise<void> {
    let held: { heldBy: string } | null;
    try {
      held = await claimDb(db.companyId, this.body, null);
    } catch (e) {
      if (!db.down) db.note?.(`the database lease can't be renewed (${(e as Error).message}): only this machine's lease file keeps a second copy out until it answers`);
      db.down = true;
      return;
    }
    if (this.lost) return;
    if (held) {
      db.note?.(`the database lease is held by ${held.heldBy}`);
      return this.lose();
    }
    if (db.down) db.note?.("the database answers again: its lease is ours");
    db.down = false;
  }

  private lose(): void {
    if (this.lost) return;
    this.lost = true;
    clearInterval(this.timer);
    this.onLost();
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    this.lost = true;
    await this.beating.catch(() => undefined);
    const cur = await read(this.file);
    if (cur?.id === this.body.id) await fs.unlink(this.file).catch(() => undefined);
    // Only ours, best effort (it goes stale anyway): the next holder needn't wait for that.
    const db = this.db;
    if (db) {
      await mongoWithin(DB_TIMEOUT_MS, (d) => d.collection<DbLease>(DB_LEASES).deleteOne({ _id: db.companyId, id: this.body.id })).catch(() => undefined);
    }
  }
}

/**
 * The file lease is ours: with MONGODB_URI the database lease must be too (held there: the file is given back).
 * `freed`: the id of the lease whose file was just taken over (its database lease may be taken too).
 */
async function withDbLease(
  file: string,
  companyId: string,
  body: LeaseBody,
  onLost: () => void,
  note: ((msg: string) => void) | undefined,
  freed: string | null,
): Promise<{ lease: Lease; note?: string } | { heldBy: string }> {
  if (!mongoConfigured()) return { lease: new Lease(file, body, onLost, null) };
  let held: { heldBy: string } | null;
  try {
    held = await claimDb(companyId, body, freed);
  } catch (e) {
    return {
      lease: new Lease(file, body, onLost, { companyId, down: true, note }),
      note: `the database lease couldn't be read (${(e as Error).message}): running on this machine's lease file alone; it is claimed once the database answers`,
    };
  }
  if (held) {
    if ((await read(file))?.id === body.id) await fs.unlink(file).catch(() => undefined);
    return { heldBy: `${held.heldBy}, by the database lease` };
  }
  return { lease: new Lease(file, body, onLost, { companyId, down: false, note }) };
}

/**
 * Takes the company's lease, or reports who holds it. `onLost` fires if it is later taken away; `note` hears the
 * database lease going out of reach and coming back. The result's `note`: what start-up should say (the database
 * couldn't be reached), for the caller to log once its log is in place.
 */
export async function acquireLease(
  dir: string,
  companyId: string,
  onLost: () => void,
  note?: (msg: string) => void,
): Promise<{ lease: Lease; note?: string } | { heldBy: string }> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `fleet-${companyId}.lock`);
  const body: LeaseBody = { pid: process.pid, host: os.hostname(), id: randomUUID(), beat: Date.now() };

  // The lease whose file this start takes over (dead, stale or this process's own): its database lease goes with it.
  let freed: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    try {
      await fs.writeFile(file, JSON.stringify(body), { flag: "wx" });
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (created) return withDbLease(file, companyId, body, onLost, note, freed);

    const cur = await read(file);
    const stat = await fs.stat(file).catch(() => null);
    const sameHost = cur?.host === body.host;
    // An unreadable file (mid-write) counts as held unless it hasn't been touched for a while.
    const free = cur
      ? (sameHost && cur.pid === body.pid) || Date.now() - cur.beat > STALE_MS || (sameHost && !alive(cur.pid))
      : !!stat && Date.now() - stat.mtimeMs > STALE_MS;
    if (!free) return { heldBy: cur ? `pid ${cur.pid} on ${cur.host}` : "another process" };
    freed = cur?.id ?? null;

    // Move the dead lease aside; only one racer's rename succeeds, then it creates a fresh one.
    try {
      const aside = `${file}.stale-${randomUUID()}`;
      await fs.rename(file, aside);
      await fs.unlink(aside).catch(() => undefined);
    } catch {
      // Someone else moved it first: try creating again (and lose to them if they already did).
    }
  }
  const cur = await read(file);
  return { heldBy: cur ? `pid ${cur.pid} on ${cur.host}` : "another process" };
}
