/**
 * Which other companies' voyage policies to underwrite, and how big a slice (pure; the fleet
 * manager polls the public policy list and places the slices).
 *
 * The edge comes from Lloyd's: every policy still open for underwriting is listed with Lloyd's own
 * estimate of its expected loss (`lloyds_expected_loss_bps`, an upper bound on the claim: legs summed,
 * rescues undercounted) and the margin over it (`premium_margin_bps` = premium − that bound), so a
 * slice earns at least that margin of its collateral. Lloyd's only looks at listings about a game hour
 * old, every couple of game hours, so players get first pick: a fresh policy at a positive margin is
 * ours if we take it before Lloyd's does. A listing without the estimate is no longer open for
 * underwriting (sailed, fully covered, expired, or no route): never written. Losses are real: a sinking or a
 * capture pays out the whole slice of the sum insured, a storm up to a quarter of the declared cargo,
 * pirates who let the ship go up to what they seized of it (at most half). So slices are small, capped
 * per policy and in total.
 */

import type { InsurancePolicyListing } from "../schema";

export interface UnderwriteRules {
  /** Our player's company ids: never our own policies. */
  ours: Set<string>;
  /**
   * Our own ships' ids (defence in depth beside `ours`): never written on, a smuggler of ours above all (guide 3.18: a
   * seizure pays nothing, and a company never underwrites its own ship).
   */
  ourShips?: ReadonlySet<string>;
  /** Server time now (ms) and real ms per game minute. */
  now: number;
  gameMinuteMs: number;
  /** Collateral we may lock in all (pence), and what is locked already. */
  budgetPence: number;
  lockedPence: number;
  /** Most collateral on one policy (pence). */
  maxPerPolicyPence: number;
  /** Least edge over Lloyd's expected loss (bps of the sum insured). */
  minEdgeBps: number;
  /** Every policy any of our companies has a slice of, whatever its status: never written on again. */
  held: Set<string>;
  /** The insured's public record on this lane and cover (rival intel), if known. */
  record?: (p: InsurancePolicyListing) => { closed: number; losses: number } | undefined;
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
  /** Upper bound on the expected loss (bps): Lloyd's estimate on the listing; null without it. */
  lossBoundBps: number | null;
  edgeBps: number | null;
  sliceBps: number;
  collateral: number;
  premiumShare: number;
  verdict: string;
}

/** Without Lloyd's estimate on the listing, a policy this old (game hours) has probably sailed. */
const MAX_AGE_GAME_HOURS = 36;
/** Lloyd's looks at listings about a game hour old: before that the pick is ours. */
const FIRST_PICK_GAME_HOURS = 1;
/** Smallest slice the game accepts, and its step; a remainder under the minimum may be taken whole. */
const MIN_SLICE = 500;
const SLICE_STEP = 100;
/** Closed policies needed before an insured's own record on a lane counts. */
const RECORD_MIN = 8;

const coverOf = (p: InsurancePolicyListing): "hull" | "cargo" => (p.insured_value_pence <= p.hull_value_pence ? "hull" : "cargo");

/**
 * The most a slice of this policy may be (bps), within `capBps` of collateral: steps of 100 from 500 up to
 * what is uncovered, or a remainder under 500 whole (guide 3.6). 0 when no slice fits.
 */
export function sliceFor(coveredBps: number, capBps = 10_000): number {
  const uncovered = Math.max(0, 10_000 - coveredBps);
  if (uncovered <= 0) return 0;
  if (uncovered < MIN_SLICE) return capBps >= uncovered ? uncovered : 0;
  const slice = Math.floor(Math.min(uncovered, capBps) / SLICE_STEP) * SLICE_STEP;
  return slice >= MIN_SLICE ? slice : 0;
}

/** Best (highest-edge) first; rows that can't be written keep their order after them. */
export function judgePolicies(policies: InsurancePolicyListing[], rules: UnderwriteRules): UnderwriteRow[] {
  let room = Math.max(0, rules.budgetPence - rules.lockedPence);
  const rows: UnderwriteRow[] = [];
  // The same policy can come from more than one list: judge it once.
  const open = [...new Map(policies.filter((p) => p.status === "open" || p.status === "active").map((p) => [p.id, p])).values()];
  // Best margins first (the budget goes to them; Lloyd's takes what is left once a listing is an hour old).
  const margin = (p: InsurancePolicyListing) => p.premium_margin_bps ?? -Infinity;
  open.sort((a, b) => margin(b) - margin(a) || b.premium_bps - a.premium_bps);
  for (const p of open) {
    // Lloyd's own estimate, listed only while the policy is open for underwriting (its ship in port at the origin, under
    // 100% covered, unexpired, a route open): without it, never written.
    const listed = typeof p.lloyds_expected_loss_bps === "number";
    const lossBound = listed ? Math.max(0, p.lloyds_expected_loss_bps!) : null;
    const edge = listed && typeof p.premium_margin_bps === "number" ? p.premium_margin_bps : lossBound !== null ? p.premium_bps - lossBound : null;
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
    // Sinkings alone are a lower bound on the insured's loss rate (partial losses never show): this only refuses.
    const rec = edge !== null && edge >= rules.minEdgeBps ? rules.record?.(p) : undefined;
    if (rules.ours.has(p.insured_company_id)) row.verdict = "our own company";
    else if (rules.ourShips?.has(p.ship_id)) row.verdict = "our own ship";
    else if (rules.held.has(p.id)) row.verdict = "we hold a slice";
    // The estimate is listed only while the policy is open for underwriting: without it, likely sailed.
    else if (!listed) row.verdict = ageGameHours > MAX_AGE_GAME_HOURS ? "too old: the ship has probably sailed" : "no Lloyd's estimate listed (sailed, or no route)";
    else if (edge === null) row.verdict = "no bound on its expected loss";
    else if (edge < rules.minEdgeBps) row.verdict = `edge ${Math.round(edge)} bps under the ${rules.minEdgeBps} bps minimum`;
    else if (rec && rec.closed >= RECORD_MIN && (rec.losses / rec.closed) * 10_000 > lossBound!)
      row.verdict = `the insured sank ${rec.losses} of ${rec.closed} on this lane: worse than Lloyd's bound`;
    else if (sliceFor(p.covered_bps) === 0) row.verdict = "fully covered";
    else {
      // The biggest slice the per-policy cap and the remaining budget allow (100 bps steps, or a small remainder whole).
      const cap = Math.min(rules.maxPerPolicyPence, room);
      const slice = sliceFor(p.covered_bps, (cap * 10_000) / p.insured_value_pence);
      if (slice === 0) row.verdict = room < rules.maxPerPolicyPence ? "budget used up" : "the smallest slice locks more than the per-policy cap";
      else {
        row.sliceBps = slice;
        row.collateral = Math.ceil((p.insured_value_pence * slice) / 10_000);
        row.premiumShare = Math.floor((p.total_premium_pence * slice) / 10_000);
        row.verdict = ageGameHours < FIRST_PICK_GAME_HOURS ? "write (first pick, before Lloyd's looks)" : "write";
        room -= row.collateral;
      }
    }
  }
  // Writable first, then those with an edge, then the rest.
  const writable = (r: UnderwriteRow) => r.sliceBps > 0 && r.verdict.startsWith("write");
  const rank = (r: UnderwriteRow) => (writable(r) ? 0 : r.edgeBps !== null ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.edgeBps ?? 0) - (a.edgeBps ?? 0));
}
