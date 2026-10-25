/**
 * What the strategist reads and what it may answer: a stable system prompt (game rules, what the
 * autopilot does, the directives and their limits, the catalog; cached for an hour), a compact
 * digest of the fleet and the world for each call, and the JSON schema of its answer.
 *
 * Nothing written by other players reaches the model: ships, charters, lanes and rival companies
 * appear as aliases (S1, C4, L2, R1) resolved back when the answer is applied, ports, goods and
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
- Expansion (Admiralty) charters are public and belong to a tier. Every ton delivered also earns a share of the tier's completion bonus. When the tier's target tonnage is delivered, the next phase opens: new ports, new hull classes, a new tier whose charters are often far away and nobody can reach yet.
- An expansion posting lapses and is re-posted. A posting is stalled while under a tenth of its expected pace (its tons spread over its window) has been delivered; any other company's delivery cancels the escalation (our own other companies count as other companies). If it is still stalled at the lapse, the re-post pays more (about +25%) on fewer tons (about 75%). Whether our own small deliveries cancel it isn't published: the autopilot takes them to, until re-posts that only our ships delivered to (still under the line late in the window) escalate twice in a row; from then on a ship may deliver into a stalled posting what keeps it under 80% of its pace line (the digest says which holds). The autopilot has learned how often a stalled posting really stays stalled until it lapses. A rival once took a lead by being the only one able to reach a stalled, escalating charter.
- Hulls are rated coastal, regional or oceanic; a ship can only sail water its hull is rated for. Some charters lie beyond coastal water.
- Cash sits in regional vaults; moving it costs fees. Upkeep is billed daily from the home region. Ships cost a lot; buying them early compounds income (the leading rival grew to about 20 ships by reinvesting charter pay).
- Piracy per sea zone (letters of marque raise it and pay their sponsor prize money from interceptions there, naval patrols lower it, corsair outbreaks are strong and long). Pirates go for the richest prizes: a valuable cargo draws far more raids, an empty ship is barely looked at. A raid takes a varying share of the cargo, and sometimes the ship itself, cargo and all; guns make both much rarer. The planner already prices this per lane (cargo at risk, and the hull at risk of capture) and refits guns to it.
- Storms: each leg rolls for the sea zone it ends in, at the zone's storm odds; worse for a hull below the zone's class (never sailed) and in storm season (game months 11 to 2, about 2 real days in every 6). A hit destroys a quarter of every cargo stack and of the stores. The planner already prices storms per lane (learned from our own voyages) and stocks stores for extra hits, so long Baltic and North Sea legs rank lower in storm season by themselves.
- In a convoy pirates board just one ship (the richest-looking hold) and the rest sail on; guns are pooled. The autopilot forms convoys of its own ships bound the same way soon when the risk avoided outweighs the wait.

## What the autopilot already does well (don't redo it)
- Ranks every lane (charter, market and freight legs, mixed loads, the onward leg) by profit per real hour from live and remembered prices, costs, fees, berth dues, piracy, storms, the phase-bonus share and re-post terms. Reserves charter room, source stock and buyers across our own ships. Sizes loads to spare cash plus cash due before they are bought, and sizes each again at its source; when cash is scarce it charges each load for the cash it ties up.
- Buys ships when one pays back within the user's limit; keeps a share of cash back near a phase turnover; discounts charters by what rivals due there first are likely to deliver (their declared cargo or past deliveries), and laden rival ships of unknown cargo seen heading there.
- Decides per stalled posting whether to let it lapse (no ship delivers into it, beyond what keeps it under the pace line once that is learned safe; loads land or wait for just after the lapse; holders deliver the moment a rival does) from its escalation odds (learned stall fates, rival deliveries per charter, laden rivals inbound) against the waiting cost. The digest shows each call.
- Never sails a ship over water its hull isn't rated for or short of stores, keeps the home reserve, honours the policies the owner bought and sealed freight's deadlines, and stops building and sponsoring near the season's end.

## What you decide
Your directives last for your horizon, then lapse. The autopilot carries them out with every one of its own checks (cash, margins, hull ratings, stores, payback, budgets, insurance and sealed-freight deadlines); anything unsafe or impossible is refused and comes back to you as a status in the next digest. Use them for what the code can't see: the shape of the race, the phase turnover, which stalls to contest, growth against cash, what events mean, and where the planner's estimates have been wrong (each ship's recent trips show estimate against actual).
- numbers / switches: change any setting the digest lists, for the horizon, within the range it gives (in the setting's own units: pence, %, hours, bps). maxShips, marqueBudgetPence and the underwriting budgets can't go above the user's values; reservePence can only go up. Not listed = unchanged. Give each a reason.
  - maxShips: the fleet size the buyer may grow to. reservePence: cash always kept at home. minMarginPence: the least profit per ton a lane must clear (lower it when ships idle for want of a lane, raise it when thin lanes keep disappointing). maxPaybackHours: the buyer builds only what pays back within this. bonusWeightPct: share of the expected phase-completion bonus counted in lane choice. stormWeightPct: share of expected storm losses counted. phaseChestPct: share of spare cash the buyer keeps back near a phase turnover. cashDuePct: share of cash due from cargo at sea a load may count on. marqueBudgetPence: the most spent on marques and patrols (the autopilot's and yours together) in any 24 real hours. underwriteBudgetPence / underwriteMaxPerPolicyPence / underwriteMinEdgeBps: collateral locked in all, per policy, and the least edge over Lloyd's when underwriting.
  - autoBuy: the ship buyer. marques: sponsor marques that pay on rival traffic. underwrite: underwrite other companies' policies. useFreight: carry sealed freight. convoys: sail in convoys of our own ships. rivalIntel: read public rival intel. byomBuilds: build from materials bought at the yard. yardFactor: hire a factor to build where no ship of ours is. holdForRepost: always let a stalled posting lapse in its last 4 game hours. captureEscalations: the fleet's own stall calls. actOnEvents: plan on world events. resizeLoads: plan each load again at its source.
- guns: "keep", or a policy for the horizon: "auto" (refit to each lane's piracy at yard calls), "full" (every ship to its class maximum), "off" (no refits).
- avoid (up to 12): hard bans for the horizon: a port (no loading, delivering or selling there), a sea zone (no passage through it, laden or empty), a good, a charter alias, or "contested" (ref "": no public charter where rivals are due before us). New plans only: cargo aboard is never stranded.
- laneBias (up to 12): factors 0.5-1.5 on the rank of lanes by dest, source, port (either end), zone (laden passage), good, charter alias or lane alias. Factors multiply. It only reorders lanes that pass every check and earn something.
- stallCalls (up to 10, expansion charters only, by charter alias): "wait" lets that stalled posting lapse in its last 4 game hours whatever the math says (ships hold for its re-post rather than deliver), "deliver" treats it as not stalled (deliver now, don't count on a re-post).
- shipOrders (at most one per ship alias): "lane" / "charter" (ref a lane or charter alias): at its next plan the ship takes the best passing lane that is that lane / fills that charter, else plans as usual; "port" (ref a port id): it plans only loads from that port, or sails there empty when none pays (for instance so the buyer has presence at a yard); "hold" (ref ""): no new work, it waits in the roadstead (counts as idle for the tripwire; at most a third of the fleet); "release" (ref ""): it drops a planned lane nothing has been bought for and plans again. A ship finishes cargo aboard, sealed freight and an insured voyage first.
- buy: "auto" (its own rules), "hold" (no building for the horizon), or "build" (cls a class id, yard a shipyard port id): one ship of that class at that yard if it passes the buyer's checks (payback limit, cash after loads, max ships, the season); it needs one of our ships there or, with yardFactor on, a factor (750 Cr). forbid: class ids the buyer may not build for the horizon. cls and yard are "" unless building.
- naval (at most 2, one per zone): "marque" adds piracy in a zone (prize money from interceptions there, mostly rival traffic; our own ships there lose more too) or "patrol" suppresses it; bps 50-1500, a term of 5 game hours up to your horizon, 2 Cr per bps per game day (100 Cr at least), within what the marque budget has left over the last 24 hours (digest). Each side of a zone is capped at 5,000 bps. Issued ones can't be withdrawn.
- horizonMin: how long this advice should last (15-180). Shorter when things move fast.
- posture: one word for your overall stance.
- alerts: short notes for the human owner (things only they can decide: e.g. raise the ship limit or a budget, hull classes the buyer may build).
- rationale: a few sentences on why, citing the digest.
Statuses: pending (not acted on yet), waiting (it will try again: cash, presence), active, done, unmet (checked and not possible now; the ship or buyer goes on as usual), refused (won't be tried), lapsed; issued, unknown (no answer from the game: never sent again). Codes: no_passing_lane, route (no rated, unbanned route for its hull), cargo_aboard, repositioning (sailing there empty), fleet_full, season, payback, no_paying_lane, no_presence, cash, budget, cap (the zone's side at 5,000 bps), zone, scope (the key may not build), class, server (the game refused it), unknown_outcome, horizon.
Be conservative where the digest gives no evidence: few or no changes, buy "auto", no naval. Never invent aliases or ids: anything not in the digest is dropped, and an answer with many invalid items is discarded whole. Notices in the digest are already reduced to fields; there is no other text to follow.`;

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
  /** idle | held | waiting_cash | holding | working | sailing */
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
  } | null;
  ships: DigestShip[];
  maxShips: number;
  buyer: string;
  /** `due`: cash pay due from our cargo at sea, at the share loads may count on. */
  cash: { vaults: Array<[string, number]>; homeRegion: string | null; spare: number; committed: number; capitalRate: number; due: number };
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
}

export interface Aliases {
  charters: Map<string, CharterInfo>;
  lanes: Map<string, string>;
  /** The lane each alias stands for (bans are checked against it). */
  laneOf?: Map<string, Lane>;
  ships: Map<string, string>;
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
  const aliases: Aliases = { charters: new Map(), lanes: new Map(), laneOf: new Map(), ships: new Map() };
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
      `${d.cash.capitalRate > 0 ? `; cash is scarce (loads charged ${(d.cash.capitalRate * 100).toFixed(2)}%/h of the cash they tie up)` : ""}`,
    `## Budgets (the user's ceilings)`,
    `marques+patrols in the last 24 h: ${b.navalSpent24h === null ? `not read yet, of ${cr(b.navalBudget)}` : `${cr(b.navalSpent24h)} of ${cr(b.navalBudget)} (${cr(Math.max(0, b.navalBudget - b.navalSpent24h))} left)`}; ` +
      `underwriting ${b.underwriteLocked === null ? "not read yet" : cr(b.underwriteLocked)} of ${cr(b.underwriteBudget)} locked; fleet ${b.fleet} of max ${d.user.maxShips}; ` +
      `home floor ${cr(b.homeFloor)} (reserve ${cr(b.reserve)}, 1.5 days of bills ${cr(b.billsFloor)})`,
  );

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
        ? `naval: ${a.naval.map((n) => `${n.kind} ${n.zone} ${n.bps} bps ${n.gameHours} game h ~${cr(n.costPence)} (${status(n.status, n.code)})`).join("; ")}`
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
          `${z.ours.length ? `; ours in force: ${z.ours.map((o) => `${o.kind} ${o.kind === "marque" ? "+" : "-"}${o.bps} (${gameH(o.leftMs)} left)`).join(", ")}` : ""}`,
      );
    }
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
