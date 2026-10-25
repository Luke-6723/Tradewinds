/**
 * What the strategist reads and what it may answer: a stable system prompt (game rules, what the
 * autopilot does, the directives and their limits, the catalog; cached for an hour), a compact
 * digest of the fleet and the world for each call, and the JSON schema of its answer.
 *
 * Nothing written by other players reaches the model: ships, charters, lanes, rival companies, our
 * loans and commissions appear as aliases (S1, C4, L2, R1, D1, K1) resolved back when the answer is applied, ports, goods and
 * zones as catalog ids, free-text notices only as the fields the Haiku screen extracted, and the
 * outcome of its orders only as fixed status codes (the game's own wording stays in the log).
 */

import type { ExpansionWatch, CharterInfo, StormSummary } from "../fleet/world";
import type { FleetSettings, GunPolicy } from "../fleet/manager";
import type { Lane, StallStake } from "../fleet/planner";
import type { TripRecord } from "../fleet/agent";
import type { Catalog } from "../types";
import type { ScreenedEvent } from "./screen";
import { aiRange, BAN_KINDS, BIAS_MATCHES, NUMBER_KEYS, SHIP_ORDERS, SWITCH_KEYS, type Active, type BanKind, type Bias, type ShipOrderKind } from "./directives";

// ── System prompt ────────────────────────────────────────────────────────────

const RULES = `You are the strategist for a fleet autopilot in Tradewinds, a multiplayer age-of-sail trading game. You advise; deterministic code does every calculation, places every order and checks every limit.

## The game
- Time runs 60x: 1 game hour is 1 real minute, a game day is 24 real minutes. Your advice is applied for its horizon (15 to 180 real minutes) and then lapses.
- Ships buy goods from NPC markets at ports and either deliver them to charters (fixed pay per ton for goods carried in from another port), sell them to NPC buyers elsewhere, or carry sealed freight for other companies.
- Expansion (Admiralty) charters are public and belong to a tier. Every ton delivered also earns a share of the tier's completion bonus (12% of the tier's base value), split by the square root of each player's tons valued at base prices, a player's companies pooled: the first tons earn the most and a leader's extra tons little (85.7% / 9.6% / 4.7% of the tons take about 64% / 21% / 15%). The planner counts each load's marginal share; the digest gives ours as the board stands. When the tier's target tonnage is delivered, the next phase opens: new ports, new hull classes, a new tier whose charters are often far away and nobody can reach yet.
- An expansion posting lapses and is re-posted. A posting is stalled while under a tenth of its expected pace (its tons spread over its window) has been delivered; any other company's delivery cancels the escalation (our own other companies count as other companies). If it is still stalled at the lapse, the re-post pays more (about +25%) on fewer tons (about 75%). Whether our own small deliveries cancel it isn't published: the autopilot takes them to, until re-posts that only our ships delivered to (still under the line late in the window) escalate twice in a row; from then on a ship may deliver into a stalled posting what keeps it under 80% of its pace line (the digest says which holds). The autopilot has learned how often a stalled posting really stays stalled until it lapses. A rival once took a lead by being the only one able to reach a stalled, escalating charter.
- Hulls are rated coastal, regional or oceanic; a ship can only sail water its hull is rated for. Some charters lie beyond coastal water.
- Cash sits in regional vaults; moving it costs fees. Upkeep is billed daily from the home region. Ships cost a lot; buying them early compounds income (the leading rival grew to about 20 ships by reinvesting charter pay).
- The Crown's wealth levy: idle vault cash above 500,000 Cr (all regions together) pays 0.1% of the excess every game day (about 6% a real day). Money working isn't levied: loads, escrow, loans out, deposits, venture stakes, goods. While there is an excess the planner charges loads nothing for the cash they tie up; more ships (maxShips, autoBuy) are one way to put it to work.
- Shipyards: a turnkey build buys each material off the yard port's ask book (players' asks and the NPC ladder, cheapest first; our own and linked asks, and asks over 2.5x the mid, are passed over), pays customs on every fill and a 15% markup on the NPC-sourced part only; byomBuilds saves that markup. A book that can't supply refuses the build. The packet (Phase 2, 16 kn, 16 t, can seal its dispatches) is a courier: the buyer never builds one.
- Ships pledged to loans: a liened ship can't be listed, sold or pledged again until repaid; a defaulted loan's ship is arrested (it can't depart or join a convoy; cargo aboard is sold toward the debt). The autopilot parks an arrested ship until our loans show it free (state "arrested").
- Loans: the Goldsmiths' Company lends against one of our ships (at most 40% of its rebuild value and 7,500 Cr a loan, 50 bps a game day, 1-30 game days, with recourse); each region's credit board holds players' standing offers and requests (5-150 bps a game day). Interest accrues daily; what is owed at maturity is taken from our vaults, and a default seizes the pledge and arrests the ship. Net worth subtracts what is owed, so borrowing never lifts us up the board. With leverage on, the autopilot borrows only to bridge a hull our own cash can't fund (against cash due from cargo at sea, at most half the hull) or a load at its source that cash limits, when the money earns at least minLoanReturnX times the interest over the term and pays back within half of it, from the cheapest board offer at or under the Goldsmiths' rate or else the Goldsmiths, with what is owed kept within maxDebtPct of net worth. What is owed is never spent on hulls, marques or lending, loads never spend what a repayment counts on, it is repaid early when cash isn't scarce, and always in full 2 game days before maturity (short: all new spending stops). No new loans in the season's last 12 hours, while one is overdue, or while our idle cash is on offer (it is taken back first). With idleCash on, vault cash above the levy's threshold (less 25,000 Cr) is lent on the credit board, secured by ship liens at 50% of value with recourse, just under the best rival rate and never under 10 bps, and taken back when the fleet needs it or we owe.
- Piracy per sea zone (letters of marque raise it and pay their sponsor prize money from interceptions there, naval patrols lower it, corsair outbreaks are strong and long). Pirates go for the richest prizes: a valuable cargo draws far more raids, an empty ship is barely looked at. An interception carries the ship off, cargo and stores and all, in 5-10% of cases (fewer the more guns face it); otherwise it seizes 20-50% of every cargo stack and of the stores and lets the ship go. Guns make interceptions much rarer. The planner already prices this per lane (cargo at risk, and the hull at risk of capture), refits guns to it and stocks stores for a raid (the route's safe figure covers one storm only).
- Storms: each leg rolls for the sea zone it ends in, at the zone's storm odds; worse for a hull below the zone's class (never sailed) and in storm season (game months 11 to 2, about 2 real days in every 6). A hit destroys a quarter of every cargo stack and of the stores. The planner already prices storms per lane (learned from our own voyages) and stocks stores for extra hits, so long Baltic and North Sea legs rank lower in storm season by themselves.
- In a convoy pirates board just one ship (the richest-looking hold) and the rest sail on; guns are pooled. The autopilot forms convoys of its own ships bound the same way soon when the risk avoided outweighs the wait. Quays post news of public forming convoys (organizer, route, sailing up to 14 game days out, muster); rival intel counts them as low-confidence traffic until a listing or a sighting shows the convoy.
- Marine insurance: Lloyd's writes a policy only at a premium of at least 2.5x its expected loss + 25 bps (it looks at a listing an hour or more old, every 2 game hours), and each open policy lists Lloyd's estimate of its expected loss (an upper bound) and the premium's margin over it. Underwriting (underwrite, underwriteMinEdgeBps: the least margin taken) writes slices where that margin is wide, first pick before Lloyd's looks; a remainder under 500 bps is taken whole. A storm claims at most 25% of the declared cargo, pirates who let the ship go at most what they seized (up to half), a sinking or capture the whole sum.
- Coffee-house gossip gives each remote port's stock, best bid and ask, and the best players' resting bid and ask with their tons (anonymous; ours left out). The planner may sell into a remote player's bid above the port's buyers and buy from a remote player's ask below the ladder, up to those tons, discounted for the news' age.
- Royal monopolies: the Crown sells the sole right to buy one good from its (NPC) asks at every port of one banking region for 5-20 game days. Everyone else, our own other companies included, buys it there only from players' resting asks (or brings it in); selling, provisioning and charters are unaffected, and provisions and silver are never monopolised. The planner sources around the monopolies listed in the digest.
- Players post charters too (paid from the poster's escrow, the goods go to its warehouse, no prestige); one posted by any of our own companies can't be delivered to, and is left out of the digest and every plan.
- Ship market: ships are listed for sale at 50-150% of their rebuild value (the class's cheapest turnkey quote plus 150 Cr a gun) and bought where they lie (quay presence there), with their stores and guns, at once. Commissions: a buyer escrows a price (50-150% of rebuild value) for a hull of a class built at a yard by a deadline, and the builder escrows up to 25% of it as collateral; the builder builds it at its own cost and gets the price and its collateral back, or forfeits the collateral at the deadline. Commissions are never freight. With shipDeals on, the buyer also buys a ship for sale at our quays that costs less than building its class (through every check a build passes), and the autopilot takes commissions at yards where we have presence when the price beats our cheapest build (turnkey, or own materials; own materials only when the turnkey walk draws on players' asks) by 10% of the price and 1,000 Cr after the collateral's risk, with the cash for the build and the collateral after loads and the deadline far enough, building and delivering at once. Our own companies' listings and commissions are never taken; the autopilot never lists our ships.
- Intelligence envelopes: at a quay where we have presence, news held there (its coffee-house board and our crews' reports, its last day of sailing notices, its non-public charters) can be sealed and sold; buyers see only a generated title and ages, never the contents. With envelopes on, the autopilot seals and lists fresh port reports and sailings (sailings only when none of ours is among them; and non-public charters, only of goods it isn't carrying, planning or letting lapse) at each of our quays every 2 game hours, at a modest price per item halved for every 12 game hours of age (10 Cr at least), withdraws them unsold after 12 game hours, and never buys any.

## What the autopilot already does well (don't redo it)
- Ranks every lane (charter, market and freight legs, mixed loads, the onward leg) by profit per real hour from live and remembered prices (remote players' resting bids and asks in the gossip included), costs, fees, berth dues, piracy, storms, the load's marginal share of the phase bonus and re-post terms. Reserves charter room, source stock and buyers across our own ships. Sizes loads to spare cash plus cash due before they are bought, and sizes each again at its source; when cash is scarce it charges each load for the cash it ties up.
- Buys ships when one pays back within the user's limit; keeps a share of cash back near a phase turnover; discounts charters by what rivals due there first are likely to deliver (their declared cargo or past deliveries), and laden rival ships of unknown cargo seen heading there.
- Decides per stalled posting whether to let it lapse (no ship delivers into it, beyond what keeps it under the pace line once that is learned safe; loads land or wait for just after the lapse; holders deliver the moment a rival does) from its escalation odds (learned stall fates, rival deliveries per charter, laden rivals inbound) against the waiting cost. The digest shows each call.
- Never sails a ship over water its hull isn't rated for or short of stores, keeps the home reserve, honours the policies the owner bought (an insured ship sails for the policy's port with what is aboard and loads nothing more: cargo added after a policy is written voids it) and sealed freight's deadlines, parks a ship arrested for a defaulted loan, and stops building and sponsoring near the season's end.

## What you decide
Your directives last for your horizon, then lapse. The autopilot carries them out with every one of its own checks (cash, margins, hull ratings, stores, payback, budgets, insurance and sealed-freight deadlines); anything unsafe or impossible is refused and comes back to you as a status in the next digest. Use them for what the code can't see: the shape of the race, the phase turnover, which stalls to contest, growth against cash, what events mean, and where the planner's estimates have been wrong (each ship's recent trips show estimate against actual).
- numbers / switches: change any setting the digest lists, for the horizon, within the range it gives (in the setting's own units: pence, %, hours, bps). maxShips, marqueBudgetPence, the underwriting budgets, maxDebtPct and cashDuePct can't go above the user's values; reservePence and minLoanReturnX can only go up; leverage and idleCash can't be switched on while the user's are off. Not listed = unchanged. Give each a reason.
  - maxShips: the fleet size the buyer may grow to. reservePence: cash always kept at home. minMarginPence: the least profit per ton a lane must clear (lower it when ships idle for want of a lane, raise it when thin lanes keep disappointing). maxPaybackHours: the buyer builds only what pays back within this. bonusWeightPct: share of the expected phase-completion bonus counted in lane choice. stormWeightPct: share of expected storm losses counted. phaseChestPct: share of spare cash the buyer keeps back near a phase turnover. cashDuePct: share of cash due from cargo at sea a load may count on. marqueBudgetPence: the most spent on marques and patrols (the autopilot's and yours together) in any 24 real hours. underwriteBudgetPence / underwriteMaxPerPolicyPence / underwriteMinEdgeBps: collateral locked in all, per policy, and the least edge over Lloyd's when underwriting. maxDebtPct: the most owed on loans, as a % of net worth (0 stops new borrowing). minLoanReturnX: how many times its interest a loan must earn over its term.
  - autoBuy: the ship buyer. marques: sponsor marques where the game's quote (prize expected from the zone's traffic) beats its price plus our own ships' extra losses. underwrite: underwrite other companies' policies. useFreight: carry sealed freight. convoys: sail in convoys of our own ships. rivalIntel: read public rival intel. byomBuilds: build from materials bought at the yard. yardFactor: hire a factor to build where no ship of ours is. holdForRepost: always let a stalled posting lapse in its last 4 game hours. captureEscalations: the fleet's own stall calls. actOnEvents: plan on world events. resizeLoads: plan each load again at its source (load loans need it). leverage: borrow to bridge hulls and loads as above. idleCash: lend idle cash above the levy's threshold on the credit board. shipDeals: buy ships for sale under building cost and build commissions to order. envelopes: sell sealed news from our quays.
- guns: "keep", or a policy for the horizon: "auto" (refit to each lane's piracy at yard calls), "full" (every ship to its class maximum), "off" (no refits).
- avoid (up to 12): hard bans for the horizon: a port (no loading, delivering or selling there), a sea zone (no passage through it, laden or empty), a good, a charter alias, or "contested" (ref "": no public charter where rivals are due before us). New plans only: cargo aboard is never stranded.
- laneBias (up to 12): factors 0.5-1.5 on the rank of lanes by dest, source, port (either end), zone (laden passage), good, charter alias or lane alias. Factors multiply. It only reorders lanes that pass every check and earn something.
- stallCalls (up to 10, expansion charters only, by charter alias): "wait" lets that stalled posting lapse in its last 4 game hours whatever the math says (ships hold for its re-post rather than deliver), "deliver" treats it as not stalled (deliver now, don't count on a re-post).
- shipOrders (at most one per ship alias): "lane" / "charter" (ref a lane or charter alias): at its next plan the ship takes the best passing lane that is that lane / fills that charter, else plans as usual; "port" (ref a port id): it plans only loads from that port, or sails there empty when none pays (for instance so the buyer has presence at a yard); "hold" (ref ""): no new work, it waits in the roadstead (counts as idle for the tripwire; at most a third of the fleet); "release" (ref ""): it drops a planned lane nothing has been bought for and plans again. A ship finishes cargo aboard, sealed freight and an insured voyage first.
- buy: "auto" (its own rules), "hold" (no building for the horizon), or "build" (cls a class id, yard a shipyard port id): one ship of that class at that yard if it passes the buyer's checks (payback limit, cash after loads, max ships, the season); it needs one of our ships there or, with yardFactor on, a factor (750 Cr). forbid: class ids the buyer may not build for the horizon. cls and yard are "" unless building.
- naval (at most 2, one per zone): "marque" adds piracy in a zone (prize money from interceptions there, mostly rival traffic, less the Admiral's tenth; our own ships there lose more too) or "patrol" suppresses it; bps 50-1500, a term of 5 game hours up to your horizon, within what the marque budget has left over the last 24 hours (digest). A patrol costs 2 Cr per bps per game day (100 Cr at least). A marque is priced by the game per zone from its last 7 game days of player traffic: 60% of the prize money a bps-day is expected to earn there (so it pays ~1.67x if traffic holds; a quiet zone is cheap but earns nothing); the digest gives a zone's last quoted price, and the autopilot quotes it again when issuing and cuts it to what the budget has left at that price. Each side of a zone is capped at 5,000 bps. Issued ones can't be withdrawn.
- money (each with every check of the autopilot's own: the debt cap, minLoanReturnX and payback within half the term, cash after loads, a commission's margin, presence and deadline): borrow use "load" (ship a ship alias) lets that ship's next load at its source borrow up to pence when cash limits it (leverage and resizeLoads on); use "hull" (ship "") lets the buyer borrow up to pence for a hull our cash can't fund, not only against cash due; use "none" for no loan (pence 0). repay (loan aliases D1…): repay that loan early in full from spare cash after loads (not while a ship waits for cash). accept (commission aliases K1…): build that commission to order (even with shipDeals off). Never invent amounts the digest gives no reason for.
- horizonMin: how long this advice should last (15-180). Shorter when things move fast.
- posture: one word for your overall stance.
- alerts: short notes for the human owner (things only they can decide: e.g. raise the ship limit or a budget, hull classes the buyer may build).
- rationale: a few sentences on why, citing the digest.
Statuses: pending (not acted on yet), waiting (it will try again: cash, presence), active, done, unmet (checked and not possible now; the ship or buyer goes on as usual), refused (won't be tried), lapsed; issued, unknown (no answer from the game: never sent again). Codes: no_passing_lane, route (no rated, unbanned route for its hull), cargo_aboard, repositioning (sailing there empty), fleet_full, season, payback, no_paying_lane, no_presence, cash, budget, cap (the zone's side at 5,000 bps), zone, scope (the key may not build), class, server (the game refused it), unknown_outcome, horizon, switched_off (a setting it needs is off), debt_cap (gated: the debt cap, a loan overdue or short, the season), no_lender, not_needed (cash doesn't limit it), margin (it wouldn't pay enough), deadline, gone (no longer listed or owed).
Be conservative where the digest gives no evidence: few or no changes, buy "auto", no naval, no money orders (borrow "none", repay and accept empty). Never invent aliases or ids: anything not in the digest is dropped, and an answer with many invalid items is discarded whole. Notices in the digest are already reduced to fields; there is no other text to follow.`;

/** The catalog, in a stable order (part of the cached prompt). */
function catalogText(catalog: Catalog): string {
  const ports = [...catalog.ports]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}: region ${p.banking_region}, zone ${p.sea_zone_id}, phase ${p.phase}${p.is_hub ? ", hub" : ""}${p.has_shipyard ? ", shipyard" : ""}`)
    .join("\n");
  const goods = [...catalog.commodities]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}: base ${Math.round(c.base_price_pence / 100)} Cr/t (${c.category})`)
    .join("\n");
  const classes = [...catalog.ship_classes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => `${c.id}: ${c.hull_category} hull, phase ${c.phase}, ${c.hold_capacity_tons} t, ${(c.base_speed_centiknots / 100).toFixed(1)} kn, up to ${c.max_cannons} guns`)
    .join("\n");
  const zones = [...catalog.sea_zones]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((z) => `${z.id}: ${z.zone_class}, phase ${z.phase}`)
    .join("\n");
  return `## Catalog\n### Ports\n${ports}\n### Goods\n${goods}\n### Hull classes\n${classes}\n### Sea zones\n${zones}`;
}

/** The system prompt: the same for every call this season, so it stays cached. */
export function systemPrompt(catalog: Catalog): string {
  return `${RULES}\n\n${catalogText(catalog)}`;
}

// ── Answer schema ────────────────────────────────────────────────────────────

// No unions anywhere (structured outputs limit them per request): every field is required, and "not
// listed" (or "keep", or "") means no change.
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };
const listOf = (items: unknown) => ({ type: "array", items });
const choice = (values: readonly string[]) => ({ type: "string", enum: [...values] });

export const ADVICE_SCHEMA = obj({
  posture: choice(["grow", "balanced", "hoard", "race_phase", "contest_stalls"]),
  horizonMin: { type: "integer" },
  numbers: listOf(obj({ key: choice(NUMBER_KEYS), value: { type: "number" }, reason: str })),
  switches: listOf(obj({ key: choice(SWITCH_KEYS), value: { type: "boolean" }, reason: str })),
  guns: obj({ policy: choice(["keep", "auto", "full", "off"]), reason: str }),
  avoid: listOf(obj({ kind: choice(BAN_KINDS), ref: str, reason: str })),
  laneBias: listOf(obj({ match: choice(BIAS_MATCHES), ref: str, factor: { type: "number" }, reason: str })),
  stallCalls: listOf(obj({ charter: str, call: choice(["wait", "deliver"]), reason: str })),
  shipOrders: listOf(obj({ ship: str, order: choice(SHIP_ORDERS), ref: str, reason: str })),
  buy: obj({ action: choice(["auto", "hold", "build"]), cls: str, yard: str, forbid: listOf(str), reason: str }),
  naval: listOf(obj({ kind: choice(["marque", "patrol"]), zone: str, bps: { type: "integer" }, gameHours: { type: "integer" }, reason: str })),
  money: obj({
    borrow: obj({ use: choice(["none", "load", "hull"]), ship: str, pence: { type: "integer" }, reason: str }),
    repay: listOf(obj({ loan: str, reason: str })),
    accept: listOf(obj({ commission: str, reason: str })),
  }),
  alerts: listOf(str),
  rationale: str,
});

export interface RawAdvice {
  posture: string;
  horizonMin: number;
  numbers: Array<{ key: string; value: number; reason: string }>;
  switches: Array<{ key: string; value: boolean; reason: string }>;
  guns: { policy: "keep" | GunPolicy; reason: string };
  avoid: Array<{ kind: BanKind; ref: string; reason: string }>;
  laneBias: Array<{ match: Bias["match"]; ref: string; factor: number; reason: string }>;
  stallCalls: Array<{ charter: string; call: "wait" | "deliver"; reason: string }>;
  shipOrders: Array<{ ship: string; order: ShipOrderKind; ref: string; reason: string }>;
  buy: { action: "auto" | "hold" | "build"; cls: string; yard: string; forbid: string[]; reason: string };
  naval: Array<{ kind: "marque" | "patrol"; zone: string; bps: number; gameHours: number; reason: string }>;
  /** Absent from answers to an older schema. */
  money?: {
    borrow: { use: "none" | "load" | "hull"; ship: string; pence: number; reason: string };
    repay: Array<{ loan: string; reason: string }>;
    accept: Array<{ commission: string; reason: string }>;
  };
  alerts: string[];
  rationale: string;
}

// ── Digest ───────────────────────────────────────────────────────────────────

export interface DigestShip {
  id: string;
  cls: string;
  /** The class's hull rating. */
  hull: string;
  status: string;
  port: string | null;
  dest: string | null;
  /** Real ms until arrival when sailing. */
  etaMs: number | null;
  /** idle | held | waiting_cash | holding | working | sailing | arrested */
  state: string;
  cargoTons: number;
  hold: number;
  /** Guns mounted and the class's most; stores aboard (t); cash the fleet can spend on its next load (pence). */
  guns: number;
  maxGuns: number;
  stores: number;
  loadCash: number;
  lane: Lane | null;
  trips: TripRecord[];
}

export interface DigestDecision {
  at: string;
  posture: string;
  applied: string;
  outcome: string;
}

/** A sea zone worth a line: piracy (bps; the split once the zones are read), rival traffic a game day, our exposure and ours in force. */
export interface DigestZone {
  zone: string;
  net: number;
  split: { base: number; marque: number; patrol: number } | null;
  rivals: { passages: number; laden: number; cargo: number } | null;
  /** Our cargo's exposure there a game day (pence·days, as the marque judge counts it). */
  ownExposure: number;
  ours: Array<{ kind: "marque" | "patrol"; bps: number; leftMs: number }>;
  /** A marque's price per bps per game day there as last quoted (pence; traffic-set), or null if not quoted lately. */
  marquePrice: number | null;
}

/** A shipyard: our ships there (ids), a factor, and the last hull quotes (pence). */
export interface DigestYard {
  port: string;
  ships: string[];
  factor: boolean;
  quotes: Array<[cls: string, pence: number]>;
}

export interface DigestInput {
  now: number;
  gameMinuteMs: number;
  phase: number;
  tier: {
    targetPhase: number | null;
    progressBps: number;
    etaMs: number | null;
    phaseSoon: boolean;
    stallSurvives: number;
    escalation: { pay: number; tons: number };
    charters: ExpansionWatch[];
    /** The fleet's call on each stalled posting (let it lapse or deliver), with its numbers. */
    stakes: StallStake[];
    /** Rival deliveries into the tier's charters seen lately (no company). */
    rivalDeliveries: Array<{ at: number; port: string; good: string; tons: number }>;
    /** Our own small deliveries into stalled postings: allowed under the pace line yet, and the record. */
    trickle: { allowed: boolean; confirmed: number; needed: number; refuted: number };
    /** Our player's share of the completion bonus as the board stands (square-root split, 0-1) and the pool (pence); null: not split yet. */
    bonus: { share: number; pool: number } | null;
  } | null;
  ships: DigestShip[];
  maxShips: number;
  buyer: string;
  /**
   * `due`: cash pay due from our cargo at sea, at the share loads may count on. `levyExcess` / `levyPerDay`: idle vault
   * cash above the wealth levy's 500,000 Cr threshold, and the levy it pays a game day (pence).
   */
  cash: { vaults: Array<[string, number]>; homeRegion: string | null; spare: number; committed: number; capitalRate: number; due: number; levyExcess: number; levyPerDay: number };
  /** The user's own settings, and whether the key may build ships. */
  user: FleetSettings;
  canBuild: boolean;
  /** Its directives in force (filled in by the advisor), and the real ms they have left. */
  inForce: (Active & { leftMs: number }) | null;
  topLanes: Lane[];
  charters: CharterInfo[];
  /** Per charter id: rivals due at its port before it lapses, by declared tons and laden ships of unknown cargo. */
  charterRivals: Map<string, { tons: number; unknown: number }>;
  /** At most 8, the most telling first. */
  zones: DigestZone[];
  /** At most 6; the buyer's best options at its last check, and its payback limit in force (hours). */
  yards: DigestYard[];
  buyerOptions: Array<{ cls: string; yard: string; paybackHours: number; costPence: number }>;
  paybackLimit: number;
  /** The user's ceilings and what is used of them (pence; null: not read yet). */
  budgets: { navalSpent24h: number | null; navalBudget: number; underwriteLocked: number | null; underwriteBudget: number; fleet: number; homeFloor: number; reserve: number; billsFloor: number };
  rivals: {
    /** Per rival company (most ships known first): ships, earning rate, top lanes and the charters it delivers to (catalog ids). */
    companies: Array<{ ships: number; laden: number; sailing: number; earnPerHour?: number | null; lanes?: string[]; feeds?: string[] }>;
    zones: Array<{ zone: string; passages: number; laden: number }>;
  };
  events: ScreenedEvent[];
  decisions: DigestDecision[];
  bidHaircutPerDay: number;
  storms: StormSummary | null;
  /** Royal monopolies in force (region, good; whether this company holds it; real ms left). */
  monopolies: Array<{ region: string; good: string; ours: boolean; leftMs: number }>;
  /**
   * Loans (guide 3.13, pence): what we owe and the cap (maxDebtPct of net worth; null: worth not known), each loan we owe
   * (rate bps a game day, real ms until it must be repaid in full, taken for a hull or a load), what borrowers owe us,
   * our idle cash on the credit board, whether a repayment due is short, and the best rival offer per region read lately.
   */
  finance: {
    owed: number;
    cap: number | null;
    worth: number | null;
    /** `id`: aliased (D1, D2…) for a repay order, never shown. */
    loans: Array<{ id: string; owed: number; rateBps: number; repayInMs: number | null; use: "hull" | "load" | null; defaulted: boolean }>;
    lentOut: number;
    offered: number;
    short: boolean;
    board: Array<{ region: string; bestOfferBps: number | null; offers: number; requests: number }>;
  };
  /**
   * Ship deals and envelopes (guide 3.4, 3.11; pence): ships for sale at our quays as the buyer last saw them (against
   * building the class, null: no quote), open commissions at our yards (`id` aliased K1, K2…; `margin`: price less our
   * cheapest build and the collateral's risk, null: not quoted; `ours`: what became of one we took), and our envelopes.
   */
  deals: {
    listings:Array<{ port: string; cls: string; price: number; build: number | null; guns: number }>;
    commissions: Array<{ id: string; yard: string; cls: string; price: number; collateral: number; leftMs: number | null; margin: number | null; ours: string | null }>;
    open: number;
    sold: number;
    income: number;
    commissionNet: number;
  };
}

export interface Aliases {
  charters: Map<string, CharterInfo>;
  lanes: Map<string, string>;
  /** The lane each alias stands for (bans are checked against it). */
  laneOf?: Map<string, Lane>;
  ships: Map<string, string>;
  /** Loans we owe (D1…) and commissions (K1…) the digest listed. */
  loans: Map<string, { id: string; owed: number }>;
  commissions: Map<string, { id: string; yard: string; cls: string; price: number; ours: boolean }>;
}

const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
const kcr = (p: number) => `${(p / 100_000).toFixed(1)}k Cr`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/**
 * The digest for one call, and the aliases it used. Every line is derived from our own state or
 * catalog ids; no names, titles or free text.
 */
export function buildDigest(d: DigestInput): { text: string; aliases: Aliases } {
  const gameH = (ms: number) => `${(ms / (60 * d.gameMinuteMs)).toFixed(1)} game h`;
  const realMin = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const aliases: Aliases = { charters: new Map(), lanes: new Map(), laneOf: new Map(), ships: new Map(), loans: new Map(), commissions: new Map() };
  // By id: what a money order in force refers to in this digest's aliases.
  const loanAlias = new Map<string, string>();
  const commissionAlias = new Map<string, string>();
  const charterAlias = new Map<string, string>();
  const aliasCharter = (c: CharterInfo) => {
    let a = charterAlias.get(c.id);
    if (!a) {
      a = `C${charterAlias.size + 1}`;
      charterAlias.set(c.id, a);
      aliases.charters.set(a, c);
    }
    return a;
  };
  const laneAlias = new Map<string, string>();
  const aliasLane = (l: Lane) => {
    let a = laneAlias.get(l.key);
    if (!a) {
      a = `L${laneAlias.size + 1}`;
      laneAlias.set(l.key, a);
      aliases.lanes.set(a, l.key);
      aliases.laneOf!.set(a, l);
    }
    return a;
  };
  const laneText = (l: Lane) =>
    `${aliasLane(l)} ${l.kind} ${l.parts.map((p) => `${p.tons}t ${p.good}${p.kind === "market" ? "(sell)" : ""}`).join("+") || "freight"} ${l.source}->${l.dest}: ` +
    `margin ${cr(l.margin)}/t${l.bonus ? ` (bonus ${cr(l.bonus)}/t)` : ""}, ~${cr(l.profitPerHour)}/h, ties up ${cr(l.capital ?? 0)}` +
    `${l.holdMs ? `, holds ${realMin(l.holdMs)} for a re-post` : ""}${l.next ? `; then ${l.next}` : ""}`;
  const status = (s: string, code?: string) => `${s}${code ? `: ${code}` : ""}`;
  const a = d.inForce;

  const out: string[] = [];
  out.push(`# Digest (server time ${new Date(d.now).toISOString()}, phase ${d.phase} open)`);

  // Tier and stalls
  if (d.tier) {
    const t = d.tier;
    out.push(
      `## Expansion tier (unlocks phase ${t.targetPhase})`,
      `progress ${pct(t.progressBps)}, completes ${t.etaMs !== null ? `in about ${realMin(t.etaMs)}` : "at an unknown pace"}${t.phaseSoon ? " (buyer is keeping cash back)" : ""}`,
      `stalled postings stay stalled to the lapse ~${Math.round(t.stallSurvives * 100)}% of the time; a stalled re-post pays x${t.escalation.pay.toFixed(2)} on x${t.escalation.tons.toFixed(2)} tons`,
      `our own deliveries into a stalled posting: ${t.trickle.allowed ? "allowed while they keep it under 80% of its pace line" : "taken to cancel the escalation"} (${t.trickle.confirmed} of ${t.trickle.needed} confirmations, ${t.trickle.refuted} counter-examples)`,
      t.bonus
        ? `completion bonus ${cr(t.bonus.pool)}: our share as the board stands ~${pct(t.bonus.share * 10_000)} (~${cr(t.bonus.pool * t.bonus.share)}; square-root split, our companies pooled)`
        : `completion bonus: no split yet (counted at a straight share of the pool)`,
    );
    for (const w of t.charters) {
      const c = d.charters.find((x) => x.id === w.id) ?? ({ id: w.id, port: w.port, good: w.good, payPerTon: w.rate, remaining: w.remaining, expiresAt: w.expiresAt, stale: false, isPublic: true, title: "", newsAt: null } as CharterInfo);
      const st = t.stakes.find((s) => s.key === `${w.port}|${w.good}`);
      const rv = t.rivalDeliveries.filter((x) => x.port === w.port && x.good === w.good);
      out.push(
        `- ${aliasCharter(c)} ${w.good} -> ${w.port}: ${cr(w.rate)}/t, ${w.remaining}t left, ${w.expiresAt ? `lapses in ${gameH(w.expiresAt - d.now)}` : "no lapse"}` +
          `${w.stalled ? ", STALLED" : ""}${w.line !== undefined && w.delivered !== undefined ? ` (pace line ${Math.round(w.line)}t, ${Math.round(w.delivered)}t delivered${w.ownTons ? `, ${Math.round(w.ownTons)}t ours` : ""})` : ""}` +
          `${w.escalations ? `, re-posted x${w.escalations}` : ""}${w.beyondCoastal ? ", beyond coastal water" : ""}` +
          `${st ? `; fleet ${st.camp ? "LETTING IT LAPSE" : "delivering"} (escalates ~${Math.round(st.p * 100)}%, lapse worth ~${cr(st.value)} vs waiting ~${cr(st.cost)}: ${st.why})` : ""}` +
          `${rv.length ? `; rivals delivered ${rv.length}x (${Math.round(rv.reduce((n, x) => n + x.tons, 0))} t) lately` : ""}`,
      );
    }
  }

  // Fleet (with each ship's order in force)
  out.push(`## Fleet (${d.ships.length} of max ${d.maxShips} ships)`);
  const shipAlias = new Map<string, string>();
  for (const [i, s] of d.ships.entries()) {
    const alias = `S${i + 1}`;
    aliases.ships.set(alias, s.id);
    shipAlias.set(s.id, alias);
    const where = s.status === "sailing" ? `sailing to ${s.dest}${s.etaMs !== null ? `, arrives in ${realMin(s.etaMs)}` : ""}` : `at ${s.port ?? "?"} (${s.state})`;
    const o = a?.shipOrders.find((x) => x.ship === s.id);
    out.push(
      `- ${alias} ${s.cls} (${s.hull}) ${s.guns}/${s.maxGuns} guns, stores ${s.stores.toFixed(1)}t, ${s.cargoTons}/${s.hold}t aboard, ${where}; spare for its next load ~${kcr(s.loadCash)}` +
        `${o ? `; your order: ${o.order}${o.label ? ` ${o.label}` : ""} (${status(o.status, o.code)})` : ""}`,
    );
    if (s.lane) out.push(`  lane ${laneText(s.lane)}`);
    const trips = s.trips.slice(-3);
    if (trips.length) out.push(`  recent trips (est -> actual Cr/h): ${trips.map((t) => `${cr(t.estPerHour)} -> ${cr(t.actualPerHour)}`).join("; ")}`);
  }
  // The buyer's status line can carry error text from the game server: only its leading words.
  const buyer = d.buyer.replace(/"[^"]*"/g, "a new ship").split(/[:(]/)[0].replace(/[^A-Za-z0-9 _.,-]/g, "").trim().slice(0, 120);
  out.push(`buyer: ${buyer || "idle"}`);

  // Cash and budgets
  const b = d.budgets;
  out.push(
    `## Cash`,
    `vaults: ${d.cash.vaults.map(([r, v]) => `${r}${r === d.cash.homeRegion ? " (home)" : ""} ${cr(v)}`).join(", ")}`,
    `spare after reserves ${cr(d.cash.spare)}, committed to loads being bought ${cr(d.cash.committed)}` +
      `${d.cash.due > 0 ? `, due from our cargo at sea ~${cr(d.cash.due)} (loads bought after it lands may count on it)` : ""}` +
      `${d.cash.capitalRate > 0 ? `; cash is scarce (loads charged ${(d.cash.capitalRate * 100).toFixed(2)}%/h of the cash they tie up)` : ""}` +
      `${d.cash.levyExcess > 0 ? `; WEALTH LEVY: ${cr(d.cash.levyExcess)} idle above the 500,000 Cr threshold pays ~${cr(d.cash.levyPerDay)} a game day (spending it on loads and hulls is free)` : ""}`,
    `## Loans`,
    `owed ${cr(d.finance.owed)}${d.finance.cap !== null ? ` of a ${cr(d.finance.cap)} cap (maxDebtPct of net worth ~${cr(d.finance.worth ?? 0)})` : " (net worth not known yet: no new loans)"}` +
      `${d.finance.short ? "; a REPAYMENT DUE IS SHORT: no new loads, hulls, marques or lending until it is paid" : ""}` +
      `${d.finance.lentOut > 0 ? `; borrowers owe us ${cr(d.finance.lentOut)}` : ""}${d.finance.offered > 0 ? `; ${cr(d.finance.offered)} of idle cash on the credit board` : ""}`,
    ...d.finance.loans.map((l, i) => {
      const alias = `D${i + 1}`;
      aliases.loans.set(alias, { id: l.id, owed: l.owed });
      loanAlias.set(l.id, alias);
      return `- ${alias} owe ${cr(l.owed)} at ${l.rateBps} bps a game day${l.use ? ` (for a ${l.use})` : ""}${l.defaulted ? ", DEFAULTED" : l.repayInMs !== null ? `, repaid in full within ${realMin(l.repayInMs)}` : ""}`;
    }),
    ...(d.finance.board.length
      ? [`credit boards read lately: ${d.finance.board.map((b) => `${b.region} ${b.bestOfferBps !== null ? `best offer ${b.bestOfferBps} bps` : "no offers"} (${b.offers} offers, ${b.requests} requests)`).join("; ")}`]
      : []),
    `## Budgets (the user's ceilings)`,
    `marques+patrols in the last 24 h: ${b.navalSpent24h === null ? `not read yet, of ${cr(b.navalBudget)}` : `${cr(b.navalSpent24h)} of ${cr(b.navalBudget)} (${cr(Math.max(0, b.navalBudget - b.navalSpent24h))} left)`}; ` +
      `underwriting ${b.underwriteLocked === null ? "not read yet" : cr(b.underwriteLocked)} of ${cr(b.underwriteBudget)} locked; fleet ${b.fleet} of max ${d.user.maxShips}; ` +
      `home floor ${cr(b.homeFloor)} (reserve ${cr(b.reserve)}, 1.5 days of bills ${cr(b.billsFloor)})`,
  );

  // Ship market, commissions (aliased for accept orders) and envelopes
  const dl = d.deals;
  out.push(
    `## Ship market, commissions and envelopes`,
    dl.listings.length
      ? `ships for sale at our quays: ${dl.listings.slice(0, 8).map((l) => `${l.cls}@${l.port} ${kcr(l.price)}${l.guns ? ` (${l.guns} guns)` : ""}${l.build !== null ? ` vs building ${kcr(l.build)}` : ""}`).join(", ")}`
      : "ships for sale at our quays: none seen lately",
  );
  for (const [i, c] of dl.commissions.slice(0, 8).entries()) {
    const alias = `K${i + 1}`;
    aliases.commissions.set(alias, { id: c.id, yard: c.yard, cls: c.cls, price: c.price, ours: c.ours !== null });
    commissionAlias.set(c.id, alias);
    out.push(
      `- ${alias} commission: a ${c.cls} at ${c.yard} for ${cr(c.price)} (collateral ${cr(c.collateral)})${c.leftMs !== null ? `, deadline in ${gameH(c.leftMs)}` : ""}` +
        `${c.margin !== null ? `, ~${cr(c.margin)} over our cheapest build after the collateral's risk` : ", not quoted"}${c.ours ? `; OURS: ${c.ours}` : ""}`,
    );
  }
  out.push(`envelopes: ${dl.open} of ours open, ${dl.sold} sold for ${cr(dl.income)} in all; commissions built to order earned ${cr(dl.commissionNet)}`);

  // Settings and ranges
  const u = d.user;
  out.push(
    `## Settings (the user's) and what you may set them to`,
    NUMBER_KEYS.map((k) => {
      const r = aiRange(k, u);
      return `${k} ${u[k]} [${r.min}-${r.max}]`;
    }).join("; "),
    `${SWITCH_KEYS.map((k) => `${k} ${u[k] ? "on" : "off"}`).join(", ")}; guns ${u.guns}; buy classes ${u.buyClasses.join(", ") || "none"}` +
      `${d.canBuild ? "" : "; the key may not build ships (autoBuy and builds stay off)"}`,
  );

  // Directives in force
  out.push(`## Your directives in force`);
  if (!a) out.push("none");
  else {
    const set = Object.entries(a.settings).filter(([k]) => k !== "buyClasses");
    const lines = [
      `${realMin(a.leftMs)} left`,
      set.length ? `settings: ${set.map(([k, v]) => `${k} ${String(v)}`).join(", ")}` : "",
      a.avoid.length ? `avoid: ${a.avoid.map((x) => x.label).join(", ")}` : "",
      a.biases.length ? `lane bias: ${a.biases.map((x) => `${x.label} x${x.factor.toFixed(2)}`).join(", ")}` : "",
      a.stallCalls.length ? `stall calls: ${a.stallCalls.map((x) => `${x.label} ${x.call}`).join(", ")}` : "",
      a.shipOrders.length ? "ship orders: on the fleet lines" : "",
      a.buyHold ? "buy: hold" : a.build ? `buy: build ${a.build.cls}@${a.build.yard} (${status(a.build.status, a.build.code)})` : "",
      a.forbid.length ? `forbid: ${a.forbid.join(", ")}` : "",
      a.naval.length
        ? `naval: ${a.naval.map((n) => `${n.kind} ${n.zone} ${n.bps} bps ${n.gameHours} game h ${n.costPence > 0 ? `~${cr(n.costPence)}` : "priced when issued"} (${status(n.status, n.code)})`).join("; ")}`
        : "",
      // (finance: absent on directives saved before money orders)
      (a.finance ?? []).length
        ? `money: ${a.finance
            .map((o) => {
              const of =
                o.kind === "borrow_load" ? (shipAlias.get(o.ref) ?? "a ship no longer listed")
                : o.kind === "repay" ? (loanAlias.get(o.ref) ?? "no longer owed")
                : o.kind === "commission" ? (commissionAlias.get(o.ref) ?? "no longer listed")
                : "";
              return `${o.label}${of ? ` (${of})` : ""} (${status(o.status, o.code)})`;
            })
            .join("; ")}`
        : "",
    ].filter(Boolean);
    out.push(...lines);
  }

  // Lanes
  out.push(`## Best lanes now (reference ship, before your bias)`);
  for (const l of d.topLanes.slice(0, 12)) out.push(`- ${laneText(l)}`);

  // Charters
  out.push(`## Open charters (top by value)`);
  for (const c of d.charters.slice(0, 20)) {
    const rv = d.charterRivals.get(c.id);
    out.push(
      `- ${aliasCharter(c)} ${c.good} -> ${c.port}: ${cr(c.payPerTon)}/t, ${c.remaining}t` +
        `${c.expiresAt ? `, lapses in ${gameH(c.expiresAt - d.now)}` : ""}${c.isPublic ? ", public" : ""}${c.provisional ? ", expected from a shortage's news, not listed yet" : c.stale ? ", gossip (may be filled)" : ""}` +
        `${rv && (rv.tons > 0 || rv.unknown > 0) ? `, rivals due first ~${Math.round(rv.tons)}t${rv.unknown > 0 ? ` +${rv.unknown} laden of unknown cargo` : ""}` : ""}`,
    );
  }

  // Sea zones (piracy, traffic, our exposure and our marques and patrols)
  if (d.zones.length) {
    out.push(`## Sea zones (net piracy bps; rival traffic a game day; our exposure)`);
    for (const z of d.zones.slice(0, 8)) {
      out.push(
        `- ${z.zone} ${z.net}${z.split ? ` (base ${z.split.base}, marques +${z.split.marque}, patrols -${z.split.patrol})` : ""}` +
          `${z.rivals ? `; rivals ${z.rivals.passages.toFixed(1)} passages, ${z.rivals.laden.toFixed(1)} laden, cargo ~${kcr(z.rivals.cargo)}` : ""}` +
          `${z.ownExposure > 0 ? `; ours exposed ~${kcr(z.ownExposure)}` : ""}` +
          `${z.marquePrice !== null ? `; a marque costs ${(z.marquePrice / 100).toFixed(2)} Cr per bps a game day (quoted)` : ""}` +
          `${z.ours.length ? `; ours in force: ${z.ours.map((o) => `${o.kind} ${o.kind === "marque" ? "+" : "-"}${o.bps} (${gameH(o.leftMs)} left)`).join(", ")}` : ""}`,
      );
    }
  }

  // Royal monopolies
  if (d.monopolies.length) {
    out.push(`## Royal monopolies in force (the holder alone buys the good from the Crown's asks across the region)`);
    for (const m of d.monopolies.slice(0, 12)) out.push(`- ${m.good} in ${m.region}: ${m.ours ? "OURS" : "held by another company"}, ${gameH(m.leftMs)} left`);
  }

  // Yards and the buyer's options
  if (d.yards.length || d.buyerOptions.length) {
    out.push(`## Yards (last hull quotes)`);
    for (const y of d.yards.slice(0, 6)) {
      const here = [...y.ships.map((id) => shipAlias.get(id)).filter((x): x is string => !!x), ...(y.factor ? ["factor"] : [])];
      out.push(`- ${y.port}${here.length ? ` [${here.join(", ")}]` : ""}: ${y.quotes.map(([c, p]) => `${c} ${kcr(p)}`).join(", ") || "no quotes yet"}`);
    }
    if (d.buyerOptions.length) {
      out.push(`buyer's best at its last check: ${d.buyerOptions.map((o) => `${o.cls}@${o.yard} pays back in ${o.paybackHours.toFixed(1)} h for ${kcr(o.costPence)}`).join(", ")} (limit ${d.paybackLimit} h)`);
    }
  }

  // Rivals
  out.push(`## Rivals seen (aliased)`);
  d.rivals.companies.slice(0, 8).forEach((r, i) =>
    out.push(
      `- R${i + 1}: ${r.ships} ships known, ${r.laden} laden, ${r.sailing} at sea` +
        `${r.earnPerHour != null ? `, earns ~${cr(r.earnPerHour)}/h` : ""}${r.lanes?.length ? `; lanes ${r.lanes.join(", ")}` : ""}${r.feeds?.length ? `; delivers ${r.feeds.join(", ")}` : ""}`,
    ),
  );

  // Events
  if (d.events.length) {
    out.push(`## Notices (screened into fields)`);
    for (const e of d.events.slice(-10)) {
      out.push(`- ${gameH(d.now - e.at)} ago: ${e.kind}, ${e.direction}, ${e.severity}${e.ports.length ? `, ports ${e.ports.join(" ")}` : ""}${e.goods.length ? `, goods ${e.goods.join(" ")}` : ""}${e.zones.length ? `, zones ${e.zones.join(" ")}` : ""}`);
    }
  }

  // Memory
  if (d.decisions.length) {
    out.push(`## Your recent advice and what followed`);
    for (const x of d.decisions.slice(-5)) out.push(`- ${x.at}: ${x.posture}, ${x.applied}; ${x.outcome}`);
  }
  out.push(`## Planner calibration`, `remembered bids are marked down ${(d.bidHaircutPerDay * 100).toFixed(1)}% per game day of age (learned)`);
  if (d.storms) {
    const s = d.storms;
    out.push(
      `storms: ${s.season ? "storm season now" : "calm season"}${s.turnsAt ? `, turns in ${gameH(Date.parse(s.turnsAt) - d.now)}` : ""}; a leg's storm odds are ` +
        `${s.perDay.calm.toFixed(2)}x (calm) / ${s.perDay.storm.toFixed(2)}x (storm season) its zone's storm bps per game day at sea, learned from ${s.seen} storms over ${s.expected} expected`,
    );
  }
  return { text: out.join("\n"), aliases };
}
