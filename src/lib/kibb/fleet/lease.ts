/**
 * Per-company lease file so only one process (dashboard server or CLI) runs a company's autopilot.
 * `fleet-<companyId>.lock` holds {pid, host, id, beat}; the holder rewrites `beat` every 30 s
 * (atomically, via rename) and removes the file on release. A lease whose beat is stale, or whose
 * pid is dead on this host, may be taken over; takeover renames the old file away first, so of two
 * racers only one wins. A holder that finds the lease gone or taken calls `onLost`. Server-only.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renameOver } from "../store";

const BEAT_MS = 30_000;
const STALE_MS = 90_000;
/** Consecutive failed heartbeats before the holder gives the lease up. */
const MAX_BEAT_FAILURES = 2;

interface LeaseBody {
  pid: number;
  host: string;
  id: string;
  beat: number;
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

export class Lease {
  private readonly timer: ReturnType<typeof setInterval>;
  private beating: Promise<void> = Promise.resolve();
  private failures = 0;
  private lost = false;

  constructor(
    private readonly file: string,
    private readonly body: LeaseBody,
    private readonly onLost: () => void,
  ) {
    this.timer = setInterval(() => {
      this.beating = this.beat();
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
      if (++this.failures >= MAX_BEAT_FAILURES) this.lose();
    }
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
  }
}

/** Takes the company's lease, or reports who holds it. `onLost` fires if it is later taken away. */
export async function acquireLease(
  dir: string,
  companyId: string,
  onLost: () => void,
): Promise<{ lease: Lease } | { heldBy: string }> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `fleet-${companyId}.lock`);
  const body: LeaseBody = { pid: process.pid, host: os.hostname(), id: randomUUID(), beat: Date.now() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, JSON.stringify(body), { flag: "wx" });
      return { lease: new Lease(file, body, onLost) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    const cur = await read(file);
    const stat = await fs.stat(file).catch(() => null);
    const sameHost = cur?.host === body.host;
    // An unreadable file (mid-write) counts as held unless it hasn't been touched for a while.
    const free = cur
      ? (sameHost && cur.pid === body.pid) || Date.now() - cur.beat > STALE_MS || (sameHost && !alive(cur.pid))
      : !!stat && Date.now() - stat.mtimeMs > STALE_MS;
    if (!free) return { heldBy: cur ? `pid ${cur.pid} on ${cur.host}` : "another process" };

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
