/**
 * Issuing freight for goods we hold in a warehouse (the issueFreight setting; guide 3.8). Pure logic, no calls.
 *
 * The game's terms: `create-freight {origin_port_id, dest_port_id, commodity_id, quantity, reward_pence, collateral_pence}` locks our
 * warehouse stock at the origin and escrows the reward; the listing stays open 5 game days (seen only at the origin's quay). A carrier
 * accepts it (the goods go into her hold, her collateral escrowed), delivers at the destination into our warehouse there (we need free
 * leased space: otherwise delivery is refused and, should the contract lapse with her waiting there, she keeps the goods and is paid), and
 * is paid the reward with her collateral back; a carrier who misses the deadline forfeits the collateral (to us) and the cargo is confiscated.
 * There is no cancel: an untaken listing lapses (freight_expired) and the goods unlock.
 *
 * When we hold goods in a warehouse (a leftover rested, a glut bought, goods a charter of ours landed) at a port where no ship of ours will
 * call for them and the resting asks there haven't sold them, freight can carry them to a port that bids better, where we lease the space
 * they land in and sell them through the same machinery. Issued only when, if a carrier takes it:
 *
 *   gain = q × (bid there on landing − an sd) − reward − rent there (the wait and the passage) − the reward's capital
 *          − FREIGHT_LOSS_P × (q × that sale − collateral)                 (a carrier lost at sea: the collateral is ours, the goods gone)
 *          − q × what the goods fetch where they lie (the better of an ask resting there and the bids now)
 *   ≥ max(FREIGHT_MIN_GAIN_PENCE, half the reward), and the sale beats the local value by FREIGHT_MIN_EDGE.
 *
 * The reward is FREIGHT_REWARD_SHARE of the cargo's value there times a multiplier learned from our own listings (up a quarter after one
 * lapses untaken, down a little after one is taken), the collateral FREIGHT_COLLATERAL_SHARE of its value where it lies.
 */

/** The reward offered, a share of the cargo's value at the destination (a carrier compares it with trading on the lane herself). */
export const FREIGHT_REWARD_SHARE = 0.12;
/** The collateral asked of the carrier: a share of the goods' value where they lie (the Merchant Adventurers ask 25-40%). */
export const FREIGHT_COLLATERAL_SHARE = 0.4;
/** The learned reward multiplier's bounds, its step up after a lapse and down after a take. */
export const FREIGHT_X_MIN = 0.8;
export const FREIGHT_X_MAX = 3;
export const FREIGHT_X_UP = 1.25;
export const FREIGHT_X_DOWN = 0.95;
/** Chance a carrier is lost at sea or defaults (the goods gone, the collateral ours). */
export const FREIGHT_LOSS_P = 0.04;
/** The wait for a carrier counted (game hours), and the deadline's slack beyond twice the passage (guide 3.8: about 2 game days). */
export const FREIGHT_ACCEPT_GAME_H = 24;
export const FREIGHT_SLACK_GAME_H = 48;
/** The least gain if taken (pence), and the sale over the local value (a share of it). */
export const FREIGHT_MIN_GAIN_PENCE = 30_000;
export const FREIGHT_MIN_EDGE = 0.25;
/** A lot worth issuing (tons), and ours live at once. */
export const FREIGHT_MIN_TONS = 5;
export const FREIGHT_MAX_OPEN = 2;
/** A listing lapses 5 game days after it is posted (guide 3.8). */
export const FREIGHT_LISTING_GAME_H = 120;
/** A post with no answer is looked for among ours this long (real ms), then taken as not made. */
export const FREIGHT_PENDING_MS = 10 * 60_000;
/** The pass's clock (real ms). */
export const FREIGHT_CHECK_MS = 5 * 60_000;
/** A lot (port and good) whose issue failed (no space or cash, an ask that wouldn't come off, refused) isn't weighed again for this long (real ms). */
export const FREIGHT_RETRY_MS = 30 * 60_000;
/** Records kept for the report. */
export const FREIGHT_ISSUED_KEPT = 20;

export interface FreightCase {
  dest: string;
  reward: number;
  collateral: number;
  /** The sale a ton at the destination on landing (less an sd), the local value a ton, the gain if taken (pence). */
  sale: number;
  local: number;
  gain: number;
}

/**
 * The case for issuing `tons` to `dest`: `sale` a ton there on landing (the curve's average less an sd), `local` a ton where they lie,
 * `rentThere` the rent on their space there over the wait and the passage (pence, all tons), `capitalPerPence` the capital charge on a
 * pence of reward escrowed until delivery, `rewardX` the learned multiplier. Null: it doesn't clear the gate.
 */
export function freightCase(x: { dest: string; tons: number; sale: number; local: number; rentThere: number; capitalPerPence: number; rewardX: number }): FreightCase | null {
  const q = Math.floor(x.tons);
  if (q < FREIGHT_MIN_TONS || !(x.sale > 0)) return null;
  const local = Math.max(0, x.local);
  const mult = Math.min(FREIGHT_X_MAX, Math.max(FREIGHT_X_MIN, x.rewardX || 1));
  const reward = Math.max(100, Math.round(FREIGHT_REWARD_SHARE * mult * q * x.sale));
  const collateral = Math.round(FREIGHT_COLLATERAL_SHARE * q * Math.max(local, 0.5 * x.sale));
  if (x.sale < local * (1 + FREIGHT_MIN_EDGE)) return null;
  const value = q * x.sale;
  const gain = value - reward - Math.max(0, x.rentThere) - reward * Math.max(0, x.capitalPerPence) - FREIGHT_LOSS_P * Math.max(0, value - collateral) - q * local;
  if (gain < Math.max(FREIGHT_MIN_GAIN_PENCE, 0.5 * reward)) return null;
  return { dest: x.dest, reward, collateral, sale: Math.round(x.sale), local: Math.round(local), gain: Math.round(gain) };
}

/** The reward multiplier after an outcome: up after a listing lapsed untaken, down a little after one was taken. */
export function nextRewardX(x: number, taken: boolean): number {
  return Math.min(FREIGHT_X_MAX, Math.max(FREIGHT_X_MIN, (x || 1) * (taken ? FREIGHT_X_DOWN : FREIGHT_X_UP)));
}

/**
 * One freight lot we issued. Times server ms. `status`: `issuing` (sent, no answer), `open` (listed, untaken), `carried` (a carrier took
 * it), `delivered`, `defaulted` (the carrier missed its deadline: the collateral ours, the goods gone), `breach` (refused at the destination
 * and lapsed: the carrier kept the goods), `expired` (untaken: the goods back in our lots), `failed` (refused, or not found after a post with
 * no answer: the goods back in our lots).
 */
export interface FreightIssueRec {
  id: string | null;
  origin: string;
  dest: string;
  good: string;
  tons: number;
  reward: number;
  collateral: number;
  /** The lot the goods came out of: cost and floor a ton, its rounds and purpose (put back as it was if the freight never sails). */
  cost: number;
  floor: number;
  rounds: number;
  purpose: "leftover" | "glut" | "landed";
  /** The case when issued: the sale a ton expected there, the local value a ton, the gain if taken. */
  sale: number;
  local: number;
  gain: number;
  status: "issuing" | "open" | "carried" | "delivered" | "defaulted" | "breach" | "expired" | "failed";
  at: number;
  /** When the listing lapses untaken; once taken, the delivery deadline (server ms; null: not known). */
  until: number;
  deadline?: number | null;
  doneAt?: number;
  why?: string;
}

export const freightLive = (r: FreightIssueRec) => r.status === "issuing" || r.status === "open" || r.status === "carried";

export interface FreightIssueStats {
  issued: number;
  carried: number;
  delivered: number;
  expired: number;
  defaulted: number;
  /** Rewards paid on lots delivered, collateral we were paid on defaults (pence). */
  rewardsPence: number;
  collateralPence: number;
}

export const emptyFreightIssueStats = (): FreightIssueStats => ({ issued: 0, carried: 0, delivered: 0, expired: 0, defaulted: 0, rewardsPence: 0, collateralPence: 0 });

/** Freight issued for the panel and the digest (pence; times ISO). */
export interface FreightIssueReport {
  enabled: boolean;
  blocked: string | null;
  rewardX: number;
  action: string;
  open: Array<{ id: string | null; route: string; good: string; tons: number; rewardPence: number; collateralPence: number; status: FreightIssueRec["status"]; until: string }>;
  recent: Array<{ at: string; route: string; good: string; tons: number; rewardPence: number; gainPence: number; status: FreightIssueRec["status"]; why: string | null }>;
  stats: FreightIssueStats;
}

const STATUSES: ReadonlyArray<FreightIssueRec["status"]> = ["issuing", "open", "carried", "delivered", "defaulted", "breach", "expired", "failed"];
const PURPOSES: ReadonlyArray<FreightIssueRec["purpose"]> = ["leftover", "glut", "landed"];

export function restoreFreightIssues(
  s: { recs?: FreightIssueRec[]; stats?: Partial<FreightIssueStats>; rewardX?: number } | undefined,
): { recs: FreightIssueRec[]; stats: FreightIssueStats; rewardX: number } {
  const stats = emptyFreightIssueStats();
  for (const k of Object.keys(stats) as (keyof FreightIssueStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.origin === "string" &&
        typeof r.dest === "string" &&
        typeof r.good === "string" &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        PURPOSES.includes(r.purpose) &&
        Number.isFinite(r.tons) &&
        Number.isFinite(r.cost) &&
        Number.isFinite(r.at) &&
        Number.isFinite(r.until),
    )
    .map((r) => ({ ...r }))
    .slice(-FREIGHT_ISSUED_KEPT);
  const x = s?.rewardX;
  return { recs, stats, rewardX: typeof x === "number" && Number.isFinite(x) ? Math.min(FREIGHT_X_MAX, Math.max(FREIGHT_X_MIN, x)) : 1 };
}
