/**
 * Posting player charters for the Merchant Adventurers' filler (the postCharters setting; guide 3.7). Pure logic, no calls.
 *
 * The game's terms: `post-charter {port_id, commodity_id, quantity, reward_per_ton_pence, duration_game_days, is_public}` needs free leased
 * warehouse space at the port for every ton (reserved) and the whole reward in our vault in its region (escrowed); the reward is capped at
 * 10x the good's base price; at most 10 open at once; `cancel-charter` (or expiry) refunds what is undelivered and frees the space. Players
 * deliver first (paid from the escrow, the goods into our warehouse there). If it is still open some game days after posting and pays
 * well over the good's base price, the Merchant Adventurers of the region send part of what is still wanted from the stockpile of the
 * nearest port in the region that makes it, one lot at a time, slowly. Whoever delivers, the goods land in our warehouse at the reward.
 *
 * So a charter is a standing buy order delivered to our door: worth posting where a port of ours bids well above what the reward, the rent
 * on the space and the escrow's capital cost come to, by the time the goods land. Landed goods are held as lots (`landed`) and sold through
 * the resting machinery (execution.ts: a resting ask over the next re-quotes, re-posted, at last sold from the warehouse), never under
 * what they cost. Conservative throughout, since the filler is slow and acts only on charters some game days old paying well over base:
 *
 *   reward r      = CHARTER_REWARD_X × base (well over base; within the 10x cap)
 *   landing at    = now + CHARTER_LAND_GAME_H (the filler's wait and its slow passage; players sooner)
 *   sale s        = the market model's bid there then, averaged over the tons (its curve), less one forecast sd
 *   edge a ton    = s − r ≥ max(minMarginPence, CHARTER_MIN_EDGE × r)
 *   expected      = p_fill × q × (s − r) − q × rent(the term and a day after) − q × r × capital(the term)  ≥ CHARTER_MIN_GAIN_PENCE
 *
 * p_fill is learned from our own charters (tons delivered over tons posted), from a modest prior. The region must hold a port other than
 * this one that makes the good (the filler's source). Cancelled when the same reckoning on the tons still wanted no longer pays half the
 * edge, the switch is off, or the season nears its end.
 */

/** The reward we offer, a multiple of the good's catalog base price (guide 3.7: the filler needs "well over" base; capped at 10x). */
export const CHARTER_REWARD_X = 1.6;
/** When the goods are expected to land (game hours after posting): the filler waits some game days, then sails slowly. */
export const CHARTER_LAND_GAME_H = 120;
/** The charter's term (game days; the game allows 2-20). */
export const CHARTER_TERM_GAME_DAYS = 10;
/** The least edge a ton (a share of the reward), and the least expected gain of a charter (pence). */
export const CHARTER_MIN_EDGE = 0.3;
export const CHARTER_MIN_GAIN_PENCE = 30_000;
/** Size bounds (tons): a charter fills slowly, a lot at a time; never more than half the NPC bids expected there take. */
export const CHARTER_MIN_TONS = 5;
export const CHARTER_MAX_TONS = 40;
/** Ours open at once (the game allows 10 a company, the user's own counted). */
export const CHARTER_MAX_OPEN = 3;
export const CHARTER_GAME_CAP = 10;
/** The prior on the share of a charter's tons that is delivered (pseudo-tons posted and delivered). */
export const CHARTER_FILL_PRIOR = { posted: 100, delivered: 40 };
/** A post with no answer is looked for among ours this long (real ms), then taken as not made. */
export const CHARTER_PENDING_MS = 10 * 60_000;
/** The pass's clock (real ms): ours read back, stale ones withdrawn, a new one weighed. */
export const CHARTER_CHECK_MS = 3 * 60_000;
/** Records kept for the report. */
export const CHARTER_POSTS_KEPT = 20;

/** The learned share of a charter's tons that gets delivered (our closed charters, from the prior). */
export function charterFillShare(posted: number, delivered: number): number {
  const p = Math.max(0, posted) + CHARTER_FILL_PRIOR.posted;
  const d = Math.min(Math.max(0, delivered), Math.max(0, posted)) + CHARTER_FILL_PRIOR.delivered;
  return Math.min(1, Math.max(0.02, d / p));
}

export interface CharterCase {
  tons: number;
  reward: number;
  /** The sale a ton expected once landed (less an sd), the edge a ton over the reward, the expected gain in all (pence). */
  sale: number;
  edge: number;
  expected: number;
}

/**
 * The case for a charter of up to `maxTons` at `reward` a ton: `saleAt(tons)` the sale a ton expected for that many tons once landed (the
 * curve's average less an sd), `rentPerTon` the rent a ton over the term and a day after, `capitalPerPence` the capital charge on a pence
 * escrowed for the term, `fill` the share expected delivered, `minMargin` the user's least margin a ton. Null: nothing pays.
 */
export function charterCase(x: {
  reward: number;
  maxTons: number;
  saleAt: (tons: number) => number | null;
  rentPerTon: number;
  capitalPerPence: number;
  fill: number;
  minMargin: number;
}): CharterCase | null {
  const r = Math.round(x.reward);
  if (!(r > 0)) return null;
  let best: CharterCase | null = null;
  for (let q = Math.floor(x.maxTons); q >= CHARTER_MIN_TONS; q = q > 20 ? q - 5 : q - 2) {
    const s = x.saleAt(q);
    if (s === null || !Number.isFinite(s)) continue;
    const edge = s - r;
    if (edge < Math.max(x.minMargin, CHARTER_MIN_EDGE * r)) continue;
    const expected = x.fill * q * edge - q * Math.max(0, x.rentPerTon) - q * r * Math.max(0, x.capitalPerPence);
    if (expected >= CHARTER_MIN_GAIN_PENCE && (!best || expected > best.expected)) best = { tons: q, reward: r, sale: Math.round(s), edge: Math.round(edge), expected: Math.round(expected) };
  }
  return best;
}

/**
 * One charter we posted. Times server ms. `status`: `posting` (sent, no answer), `open` (listed, tons still wanted), `cancelling`
 * (withdrawal sent, no answer), `done` (filled), `cancelled`, `expired`, `failed` (refused, or not found after a post with no answer).
 */
export interface CharterPostRec {
  id: string | null;
  port: string;
  good: string;
  qty: number;
  /** Reward a ton (pence), the good's base price then. */
  reward: number;
  base: number;
  /** The case when posted: the sale a ton expected once landed, the edge a ton, the expected gain. */
  sale: number;
  edge: number;
  expected: number;
  status: "posting" | "open" | "cancelling" | "done" | "cancelled" | "expired" | "failed";
  at: number;
  expiresAt: number;
  /** Tons delivered and taken into our lots; tons the filler said it sent. */
  delivered: number;
  dispatched?: number;
  doneAt?: number;
  why?: string;
}

export const charterLive = (r: CharterPostRec) => r.status === "posting" || r.status === "open" || r.status === "cancelling";

/**
 * Tons a charter of ours had delivered in all when it was withdrawn (cancel-charter's answer): its quantity less what the cancel freed
 * (`released`: the space held for the undelivered tons; `refunded`: their reward, in tons at `reward` a ton; the larger of the two taken,
 * so nothing is booked that didn't land), never under what was already booked nor over the quantity. Null: the answer says neither.
 */
export function charterDeliveredAtCancel(qty: number, reward: number, booked: number, released: number | null | undefined, refunded: number | null | undefined): number | null {
  const left: number[] = [];
  if (typeof released === "number" && Number.isFinite(released) && released >= 0) left.push(released);
  if (typeof refunded === "number" && Number.isFinite(refunded) && refunded >= 0 && reward > 0) left.push(refunded / reward);
  if (!left.length) return null;
  return Math.min(qty, Math.max(booked, Math.round((qty - Math.max(...left)) * 100) / 100));
}

export interface CharterPostStats {
  posted: number;
  cancelled: number;
  expired: number;
  done: number;
  /** Tons posted and delivered on closed charters (the fill share's data); tons delivered in all and what they cost (pence). */
  postedTons: number;
  filledTons: number;
  deliveredTons: number;
  deliveredPence: number;
  /** Lots the filler said it sent. */
  dispatched: number;
}

export const emptyCharterPostStats = (): CharterPostStats => ({ posted: 0, cancelled: 0, expired: 0, done: 0, postedTons: 0, filledTons: 0, deliveredTons: 0, deliveredPence: 0, dispatched: 0 });

/** Charters posted for the panel and the digest (pence; times ISO). */
export interface CharterPostReport {
  enabled: boolean;
  blocked: string | null;
  budgetPence: number;
  /** Escrow on the tons still wanted, and the landed goods held at cost. */
  escrowPence: number;
  heldPence: number;
  fillShare: number;
  action: string;
  open: Array<{ id: string | null; port: string; good: string; qty: number; delivered: number; rewardPence: number; salePence: number; status: CharterPostRec["status"]; expiresAt: string }>;
  recent: Array<{ at: string; port: string; good: string; qty: number; delivered: number; rewardPence: number; status: CharterPostRec["status"]; why: string | null }>;
  stats: CharterPostStats;
}

const STATUSES: ReadonlyArray<CharterPostRec["status"]> = ["posting", "open", "cancelling", "done", "cancelled", "expired", "failed"];

export function restoreCharterPosts(s: { recs?: CharterPostRec[]; stats?: Partial<CharterPostStats> } | undefined): { recs: CharterPostRec[]; stats: CharterPostStats } {
  const stats = emptyCharterPostStats();
  for (const k of Object.keys(stats) as (keyof CharterPostStats)[]) {
    const v = s?.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
  }
  const recs = (Array.isArray(s?.recs) ? s!.recs : [])
    .filter(
      (r) =>
        r &&
        typeof r.port === "string" &&
        typeof r.good === "string" &&
        (r.id === null || typeof r.id === "string") &&
        STATUSES.includes(r.status) &&
        Number.isFinite(r.qty) &&
        Number.isFinite(r.reward) &&
        Number.isFinite(r.at) &&
        Number.isFinite(r.expiresAt),
    )
    .map((r) => ({ ...r, delivered: Number.isFinite(r.delivered) ? r.delivered : 0 }))
    .slice(-CHARTER_POSTS_KEPT);
  return { recs, stats };
}
