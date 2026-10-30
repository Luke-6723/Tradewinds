/**
 * Insuring our own ships' voyages (the insureLevered setting; guide 3.6). Pure logic, no calls.
 *
 * The game's terms: `insurance/create {ship_id, dest_port_id, insured_value_pence, premium_bps}` with the ship in port (berthed or in the
 * roadstead), one open policy a ship; the premium is escrowed and what nobody writes is refunded at settlement. The sum insured is at most
 * the hull's rebuild value plus the cargo aboard (valued at the higher of base and the port's NPC mid); declaring all of it is what keeps
 * the cover from being voided (`cargo_exceeds_declared`), so a policy declares `max_insurable_pence`. Lloyd's writes what players leave at
 * its posted price (1.25x its expected loss + 25 bps, or 1x + 25 bps when the hull is rated for every leg's water), once the policy is a
 * game hour old, every two game hours, within its collateral caps (about a tenth of its funds on one policy). Bound at departure: void
 * if she sails anywhere else, if consorts it priced don't sail with her, or if cargo is added. A sinking or capture pays the whole sum
 * insured; a storm the share it destroyed of the declared cargo; pirates who let her go the share they seized (at most half).
 *
 * The autopilot is risk-averse only through the Kelly view (allocation.ts: log utility of the bankroll). Insurance is a fair bet at
 * best (Lloyd's charges its expected loss plus a margin, and its estimate is an upper bound), so it is bought only where the variance it
 * takes off is worth more to the log-growth of what we own than the premium over the expected claim: one hull and her cargo a large share
 * of net worth (a young fleet, a rich cargo, a fleet grown on credit: net worth already nets what we owe). Our own loss model's odds (the
 * planner's) are the truth; the certainty equivalent of net worth B with and without the policy:
 *
 *   CE(x) = B · (exp(Σ w · ln(1 + x/B)) − 1)        over the voyage's states: lost (hull and cargo), raided × storm-damaged
 *   gain  = CE(insured: −premium·c, claims·c) − CE(uninsured) − what waiting for the cover costs her
 *
 * (c: the share of the sum Lloyd's caps let it write). Bought only when hull and cargo are at least INSURE_MIN_SHARE of B and the gain
 * clears INSURE_MIN_GAIN_PENCE and INSURE_MIN_GAIN_SHARE of the premium: strict, so it fires rarely.
 */

/** Hull and cargo must be at least this share of net worth before a quote is even read. */
export const INSURE_MIN_SHARE = 0.25;
/** The certainty-equivalent gain a policy must clear (pence), and as a share of the premium charged. */
export const INSURE_MIN_GAIN_PENCE = 50_000;
export const INSURE_MIN_GAIN_SHARE = 0.25;
/** Lloyd's writes at most about a tenth of its funds on one policy (guide 3.6: ~64,000 Cr in a fresh world): what we count on it covering. */
export const INSURE_LLOYDS_CAP_PENCE = 6_000_000;
/** Lloyd's looks at a policy once it is a game hour old, every two game hours: the longest we wait in port for its cover (game hours). */
export const INSURE_WAIT_GAME_H = 3.25;
/** A voyage weighed once and not insured is not weighed again from the same port for that long (real ms). */
export const INSURE_RETRY_MS = 20 * 60_000;
/** A policy written with no answer is looked for among ours this long (real ms), then taken as not written. */
export const INSURE_PENDING_MS = 5 * 60_000;
/** A write with no answer whose policy list can't be read is given up this long after it was sent (real ms): never live forever. */
export const INSURE_WRITE_GIVE_UP_MS = 30 * 60_000;
/** Our policies' records read back on this clock (real ms): sailed, settled. */
export const INSURE_REVIEW_MS = 2 * 60_000;
/** Records kept for the report. */
export const INSURE_KEPT = 20;

/** One voyage as the policy and our loss model see it (pence; probabilities for this passage). */
export interface VoyageRisk {
  /** Net worth (the bankroll the Kelly view is on). */
  bankroll: number;
  /** The hull's value on the policy (its rebuild value: what losing her takes off net worth). */
  hull: number;
  /** What our cargo aboard is worth to us (its sale at the destination). */
  cargo: number;
  /** The cargo the policy declares (the sum insured less the hull): the cap on partial claims. */
  declared: number;
  /** Chance she is lost (captured or sunk) on the passage. */
  lost: number;
  /** Given she isn't lost: the chance of a raid that lets her go and the share it seizes; of storm damage and its share. */
  raid: number;
  raidTake: number;
  storm: number;
  stormTake: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** Log-utility certainty equivalent of the changes `x` (pence) at weights `w` on bankroll `b` (pence). Floors at a 99% loss. */
export function certaintyOf(w: readonly number[], x: readonly number[], b: number): number {
  if (!(b > 0)) return w.reduce((n, wi, i) => n + wi * x[i], 0);
  let g = 0;
  for (let i = 0; i < w.length; i++) g += w[i] * Math.log(Math.max(0.01, 1 + x[i] / b));
  return b * Math.expm1(g);
}

/** The voyage's states (weights) and what each takes off net worth uninsured, and what a policy pays in each per unit of cover. */
export function voyageStates(v: VoyageRisk): { w: number[]; loss: number[]; claim: number[] } {
  const w: number[] = [];
  const loss: number[] = [];
  const claim: number[] = [];
  const lost = Math.min(0.95, clamp01(v.lost));
  const sum = Math.max(0, v.hull) + Math.max(0, v.declared);
  if (lost > 0) {
    w.push(lost);
    loss.push(Math.max(0, v.hull) + Math.max(0, v.cargo));
    claim.push(sum);
  }
  const pr = clamp01(v.raid);
  const ps = clamp01(v.storm);
  for (const r of [0, 1]) {
    for (const s of [0, 1]) {
      const q = (1 - lost) * (r ? pr : 1 - pr) * (s ? ps : 1 - ps);
      if (!(q > 0)) continue;
      const raided = r * Math.min(0.5, clamp01(v.raidTake));
      const stormed = s * clamp01(v.stormTake);
      // Each takes its share of what is left; a claim pays each share of the declared cargo (pirates at most half).
      const share = 1 - (1 - raided) * (1 - stormed);
      w.push(q);
      loss.push(share * Math.max(0, v.cargo));
      claim.push(share * Math.max(0, v.declared));
    }
  }
  return { w, loss, claim };
}

export interface InsureCase {
  /** Certainty-equivalent gain of the policy over none, net of the wait (pence). */
  gain: number;
  /** Expected loss on our model, and the expected claim at the cover counted (pence). */
  expectedLoss: number;
  expectedClaim: number;
  /** The premium charged at that cover (pence). */
  premium: number;
  /** Share of the sum insured counted as covered. */
  cover: number;
  /** Hull and cargo as a share of net worth. */
  share: number;
}

/**
 * The case for a policy at `premiumBps` on `sum` insured (the posted price on the whole sum declared), Lloyd's covering up to `capPence`
 * of it, the wait for its cover costing `waitCost`. Null: no net worth to weigh it on.
 */
export function insureCase(v: VoyageRisk, sum: number, premiumBps: number, capPence = INSURE_LLOYDS_CAP_PENCE, waitCost = 0): InsureCase | null {
  if (!(v.bankroll > 0) || !(sum > 0)) return null;
  const cover = Math.min(1, Math.max(0, capPence) / sum);
  const premium = (Math.max(0, premiumBps) / 10_000) * sum * cover;
  // Every state is listed (the quiet one too: nothing lost, the premium still paid), so the weights sum to one.
  const s = voyageStates(v);
  const ceNone = certaintyOf(
    s.w,
    s.loss.map((l) => -l),
    v.bankroll,
  );
  const ceIns = certaintyOf(
    s.w,
    s.loss.map((l, i) => -l + cover * s.claim[i] - premium),
    v.bankroll,
  );
  const expectedLoss = s.w.reduce((n, wi, i) => n + wi * s.loss[i], 0);
  const expectedClaim = s.w.reduce((n, wi, i) => n + wi * cover * s.claim[i], 0);
  return {
    gain: Math.round(ceIns - ceNone - Math.max(0, waitCost)),
    expectedLoss: Math.round(expectedLoss),
    expectedClaim: Math.round(expectedClaim),
    premium: Math.round(premium),
    cover,
    share: (Math.max(0, v.hull) + Math.max(0, v.cargo)) / v.bankroll,
  };
}

/** Whether the case clears the strict gate: the share of net worth at stake, the gain in pence and as a share of the premium. */
export function insureWorth(c: InsureCase): boolean {
  return c.share >= INSURE_MIN_SHARE && c.gain >= Math.max(INSURE_MIN_GAIN_PENCE, INSURE_MIN_GAIN_SHARE * c.premium);
}

/** The most of `sum` Lloyd's writes on one policy (bps of the sum): its cap over the sum, never over the whole. */
export function lloydsCapBps(sum: number, capPence = INSURE_LLOYDS_CAP_PENCE): number {
  if (!(sum > 0)) return 10_000;
  return Math.max(0, Math.min(10_000, Math.floor((Math.max(0, capPence) / sum) * 10_000)));
}

/**
 * Whether waiting in port for more cover is pointless: all written, or as much as Lloyd's cap on one policy lets it write (`capBps`; a
 * slice short for its rounding to whole hundreds). Absent: the whole sum is waited for.
 */
export function insureCoverDone(coveredBps: number, capBps?: number): boolean {
  if (coveredBps >= 10_000) return true;
  return capBps !== undefined && capBps < 10_000 && coveredBps >= capBps - 100;
}

/**
 * One policy we wrote on a ship of ours. Times server ms. `status`: `writing` (sent, no answer), `open` (written, cover being taken),
 * `sailed` (bound at departure), `settled` (arrived), `claimed` (a loss paid), `void` (cancelled or voided), `failed` (refused, or not
 * found after a post with no answer).
 */
export interface InsureRec {
  id: string | null;
  shipId: string;
  ship: string;
  from: string;
  dest: string;
  sum: number;
  premiumBps: number;
  /** The premium escrowed at the posted price (pence), the case's gain, expected loss on our model, hull and cargo as a share of net worth. */
  premium: number;
  gain: number;
  expectedLoss: number;
  share: number;
  /** Lloyd's estimate of the expected loss (bps of the sum; an upper bound). */
  lloydsElBps: number;
  status: "writing" | "open" | "sailed" | "settled" | "claimed" | "void" | "failed";
  at: number;
  /** Cover as last read (bps of the sum written). */
  covered?: number;
  /** The most of the sum Lloyd's cap on one policy lets it write (bps; lloydsCapBps): she waits for no more. Absent: the whole. */
  capBps?: number;
  /** Claims paid to us on it (pence). */
  claims?: number;
  doneAt?: number;
  why?: string;
}

export const insureLive = (r: InsureRec) => r.status === "writing" || r.status === "open" || r.status === "sailed";

export interface InsureStats {
  weighed: number;
  quoted: number;
  written: number;
  settled: number;
  claimed: number;
  voided: number;
  /** Premium at the posted price on policies written (pence; what nobody wrote comes back), claims paid to us (pence). */
  premiumPence: number;
  claimsPence: number;
}

export const emptyInsureStats = (): InsureStats => ({ weighed: 0, quoted: 0, written: 0, settled: 0, claimed: 0, voided: 0, premiumPence: 0, claimsPence: 0 });

/** Insuring our voyages for the panel and the digest (pence; times ISO). */
export interface InsureReport {
  enabled: boolean;
  blocked: string | null;
  /** The last voyage weighed and the verdict. */
  action: string;
  open: Array<{ ship: string; route: string; sumPence: number; premiumBps: number; coveredBps: number | null; status: InsureRec["status"]; at: string }>;
  recent: Array<{ at: string; ship: string; route: string; sumPence: number; premiumPence: number; gainPence: number; share: number; status: InsureRec["status"]; claimsPence: number; why: string | null }>;
  stats: InsureStats;
}

const STATUSES: ReadonlyArray<InsureRec["status"]> = ["writing", "open", "sailed", "settled", "claimed", "void", "failed"];

export function restoreInsure(s: { recs?: InsureRec[]; stats?: Partial<InsureStats> } | undefined): { recs: InsureRec[]; stats: InsureStats } {
  const stats = emptyInsureStats();
  for (const k of Object.keys(stats) as (keyof InsureStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.shipId === "string" &&
        typeof r.dest === "string" &&
        typeof r.from === "string" &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        Number.isFinite(r.sum) &&
        Number.isFinite(r.at),
    )
    .map((r) => {
      const x = { ...r };
      if (x.capBps !== undefined && !(Number.isFinite(x.capBps) && x.capBps >= 0)) delete x.capBps;
      return x;
    })
    .slice(-INSURE_KEPT);
  return { recs, stats };
}
