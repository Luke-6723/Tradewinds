/**
 * Which other companies' voyage policies to underwrite, and how big a slice (pure; the fleet
 * manager polls the public policy list and places the slices).
 *
 * The edge comes from Lloyd's: it writes only when the premium is at least ceil(1.25 × its
 * expected loss) + 25 bps, and its loss estimate is cautious. So a policy someone other than us
 * has already partly covered (in practice Lloyd's, which locks at most 10% of its funds on one
 * policy) implies that policy's expected loss is at most (premium − 25) / 1.25, and a slice of it
 * earns at least 0.2 × premium + 20 bps of the collateral. That bound holds for this ship, this
 * voyage and today's piracy; a bound borrowed from other ships on the lane wouldn't, so policies
 * nobody has covered are left alone: young ones wait for Lloyd's review, older ones were declined.
 * Losses are real: a sinking pays out the whole slice of the sum insured, a pirate or storm hit up
 * to a quarter of the declared cargo. So slices are small, capped per policy and in total, and
 * only on fresh policies whose ship is most likely still in port.
 */

import type { InsurancePolicy } from "../schema";

export interface UnderwriteRules {
  /** Our player's company ids: never our own policies. */
  ours: Set<string>;
  /** Server time now (ms) and real ms per game minute. */
  now: number;
  gameMinuteMs: number;
  /** Collateral we may lock in all (pence), and what is locked already. */
  budgetPence: number;
  lockedPence: number;
  /** Most collateral on one policy (pence). */
  maxPerPolicyPence: number;
  /** Least edge over the Lloyd's-implied expected loss (bps of the sum insured). */
  minEdgeBps: number;
  /** Every policy any of our companies has a slice of, whatever its status: their cover is ours, not Lloyd's. */
  held: Set<string>;
  /** The insured's public record on this lane and cover (rival intel), if known. */
  record?: (p: InsurancePolicy) => { closed: number; losses: number } | undefined;
}

export interface UnderwriteRow {
  policy: string;
  lane: string;
  /** Origin port: the collateral may be locked in its banking region. */
  origin: string;
  cover: "hull" | "cargo";
  insured: number;
  premiumBps: number;
  coveredBps: number;
  /** Upper bound on the expected loss implied by the policy's own cover (bps), or null. */
  lossBoundBps: number | null;
  edgeBps: number | null;
  sliceBps: number;
  collateral: number;
  premiumShare: number;
  verdict: string;
}

/** Lloyd's writes at most this long after listing, and ships leave soon after cover: older is likely at sea. */
const MAX_AGE_GAME_HOURS = 36;
/** Lloyd's reviews policies open about a game hour, every couple of game hours: uncovered past this, it declined. */
const LLOYDS_REVIEW_GAME_HOURS = 4;
/** Smallest slice the game accepts, and its step. */
const MIN_SLICE = 500;
const SLICE_STEP = 100;
/** Closed policies needed before an insured's own record on a lane counts. */
const RECORD_MIN = 8;

const coverOf = (p: InsurancePolicy): "hull" | "cargo" => (p.insured_value_pence <= p.hull_value_pence ? "hull" : "cargo");

/** Best (highest-edge) first; rows that can't be written keep their order after them. */
export function judgePolicies(policies: InsurancePolicy[], rules: UnderwriteRules): UnderwriteRow[] {
  let room = Math.max(0, rules.budgetPence - rules.lockedPence);
  const rows: UnderwriteRow[] = [];
  // The same policy can come from more than one list: judge it once.
  const open = [...new Map(policies.filter((p) => p.status === "open" || p.status === "active").map((p) => [p.id, p])).values()].sort(
    (a, b) => b.premium_bps - a.premium_bps,
  );
  for (const p of open) {
    // Cover that isn't ours: what Lloyd's (most likely) wrote, so the premium passed its test.
    const vetted = p.covered_bps > 0 && !rules.held.has(p.id);
    const lossBound = vetted ? Math.max(0, (p.premium_bps - 25) / 1.25) : null;
    const edge = lossBound !== null ? p.premium_bps - lossBound : null;
    const row: UnderwriteRow = {
      policy: p.id,
      lane: `${p.origin_port_id} → ${p.dest_port_id}`,
      origin: p.origin_port_id,
      cover: coverOf(p),
      insured: p.insured_value_pence,
      premiumBps: p.premium_bps,
      coveredBps: p.covered_bps,
      lossBoundBps: lossBound === null ? null : Math.round(lossBound),
      edgeBps: edge === null ? null : Math.round(edge),
      sliceBps: 0,
      collateral: 0,
      premiumShare: 0,
      verdict: "",
    };
    rows.push(row);

    const ageGameHours = (rules.now - Date.parse(p.created_at)) / (60 * rules.gameMinuteMs);
    const uncovered = Math.floor((10_000 - p.covered_bps) / SLICE_STEP) * SLICE_STEP;
    // Sinkings alone are a lower bound on the insured's loss rate (partial losses never show): this only refuses.
    const rec = edge !== null && edge >= rules.minEdgeBps ? rules.record?.(p) : undefined;
    if (rules.ours.has(p.insured_company_id)) row.verdict = "our own company";
    else if (rules.held.has(p.id)) row.verdict = "we hold a slice";
    else if (ageGameHours > MAX_AGE_GAME_HOURS) row.verdict = "too old: the ship has probably sailed";
    else if (edge === null)
      row.verdict = ageGameHours > LLOYDS_REVIEW_GAME_HOURS ? "Lloyd's reviewed it and declined" : "waiting for Lloyd's review";
    else if (edge < rules.minEdgeBps) row.verdict = `edge ${Math.round(edge)} bps under the ${rules.minEdgeBps} bps minimum`;
    else if (rec && rec.closed >= RECORD_MIN && (rec.losses / rec.closed) * 10_000 > lossBound!)
      row.verdict = `the insured sank ${rec.losses} of ${rec.closed} on this lane: worse than Lloyd's bound`;
    else if (uncovered < MIN_SLICE) row.verdict = "fully covered";
    else {
      // The biggest slice the per-policy cap and the remaining budget allow, in 100 bps steps.
      const cap = Math.min(rules.maxPerPolicyPence, room);
      const slice = Math.min(uncovered, Math.floor(((cap * 10_000) / p.insured_value_pence) / SLICE_STEP) * SLICE_STEP);
      if (slice < MIN_SLICE) row.verdict = room < rules.maxPerPolicyPence ? "budget used up" : "a 5% slice locks more than the per-policy cap";
      else {
        row.sliceBps = slice;
        row.collateral = Math.round((p.insured_value_pence * slice) / 10_000);
        row.premiumShare = Math.round((p.total_premium_pence * slice) / 10_000);
        row.verdict = "write";
        room -= row.collateral;
      }
    }
  }
  // Writable first, then those with an edge, then the rest.
  const rank = (r: UnderwriteRow) => (r.verdict === "write" ? 0 : r.edgeBps !== null ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.edgeBps ?? 0) - (a.edgeBps ?? 0));
}
