/**
 * What the strategist reads and what it may answer: a stable system prompt (game rules, what the
 * autopilot does, the directives and their limits, the catalog; cached for an hour), a compact
 * digest of the fleet and the world for each call, and the JSON schema of its answer.
 *
 * Nothing written by other players reaches the model: ships, charters, lanes and rival companies
 * appear as aliases (S1, C4, L2, R1) resolved back when the answer is applied, ports, goods and
 * zones as catalog ids, and free-text notices only as the fields the Haiku screen extracted.
 */

import type { ExpansionWatch, CharterInfo } from "../fleet/world";
import type { FleetSettings } from "../fleet/manager";
import type { Lane } from "../fleet/planner";
import type { TripRecord } from "../fleet/agent";
import type { Catalog } from "../types";
import type { ScreenedEvent } from "./screen";

// ── Limits on what the strategist may change ─────────────────────────────────

/** Lane bias: a factor on a lane's rank (never makes a lane eligible). */
export const BIAS_MIN = 0.5;
export const BIAS_MAX = 1.5;
export const MAX_BIASES = 12;
export const MAX_STALL_CALLS = 10;
/** How long its directives last before they lapse (minutes). */
export const HORIZON_MIN = 15;
export const HORIZON_MAX = 180;
/** Setting overrides: absolute bounds and the most one answer may move each from the user's value. */
export const ENVELOPE = {
  bonusWeightPct: { min: 50, max: 100, step: 15 },
  phaseChestPct: { min: 0, max: 70, step: 20 },
  /** As a multiple of the user's own minimum margin. */
  minMarginFactor: { min: 0.5, max: 2 },
} as const;

// ── System prompt ────────────────────────────────────────────────────────────

const RULES = `You are the strategist for a fleet autopilot in Tradewinds, a multiplayer age-of-sail trading game. You advise; deterministic code does every calculation, places every order and checks every limit.

## The game
- Time runs 60x: 1 game hour is 1 real minute, a game day is 24 real minutes. Your advice is applied for its horizon (15 to 180 real minutes) and then lapses.
- Ships buy goods from NPC markets at ports and either deliver them to charters (fixed pay per ton for goods carried in from another port), sell them to NPC buyers elsewhere, or carry sealed freight for other companies.
- Expansion (Admiralty) charters are public and belong to a tier. Every ton delivered also earns a share of the tier's completion bonus. When the tier's target tonnage is delivered, the next phase opens: new ports, new hull classes, a new tier whose charters are often far away and nobody can reach yet.
- An expansion posting lapses and is re-posted. If nothing was delivered to it during its posting (it "stalled"), the re-post pays more (about +25%) on fewer tons (about 75%). The autopilot has learned how often a stalled posting really stays stalled until it lapses. A rival once took a lead by being the only one able to reach a stalled, escalating charter.
- Hulls are rated coastal, regional or oceanic; a ship can only sail water its hull is rated for. Some charters lie beyond coastal water.
- Cash sits in regional vaults; moving it costs fees. Upkeep is billed daily from the home region. Ships cost a lot; buying them early compounds income (the leading rival grew to about 20 ships by reinvesting charter pay).
- Piracy per sea zone (letters of marque raise it, naval patrols lower it, corsair outbreaks are strong and long). Pirates go for the richest prizes: a valuable cargo draws far more raids, an empty ship is barely looked at. A raid takes a varying share of the cargo, and sometimes the ship itself, cargo and all; guns make both much rarer. The planner already prices this per lane (cargo at risk, and the hull at risk of capture) and refits guns to it.
- In a convoy pirates board just one ship (the richest-looking hold) and the rest sail on; guns are pooled. The autopilot doesn't form convoys yet.

## What the autopilot already does well (don't redo it)
- Ranks every lane (charter, market and freight legs, mixed loads, the onward leg) by profit per real hour from live and remembered prices, costs, fees, piracy, the phase-bonus share and re-post terms. Reserves charter room, source stock and buyers across our own ships. Sizes loads to spare cash, and when cash is scarce charges each load for the cash it ties up.
- Buys ships when one pays back within the user's limit; keeps a share of cash back near a phase turnover; discounts public charters where laden rival ships are seen heading first.
- Holds cargo for a stalled posting's re-post only if the user turned that on (or you call it for a specific charter).

## What you decide
Your levers are coarse on purpose. Use them for what the code can't see: the shape of the race, the phase turnover, which stalled charters to contest, whether to grow the fleet or keep cash, what world events mean, and where the planner's estimates have been wrong (each ship's recent trips show estimate against actual).
- settings: temporary overrides of a few user settings, each clamped to its limits (given in the digest) and moved at most one step from the user's value per answer. null means leave it as the user set it.
  - bonusWeightPct: how much of the expected phase-completion bonus counts when choosing lanes (50-100).
  - phaseChestPct: share of spare cash the ship buyer leaves alone while the tier is close to completing (0-70).
  - minMarginPence: the least profit per ton a lane must clear (between half and twice the user's value). Lower it when ships sit idle for want of a lane; raise it when thin lanes keep disappointing.
  - holdForRepost: whether ships may hold cargo for any stalled posting's re-post.
- laneBias: up to 12 entries, each a factor from 0.5 to 1.5 on the rank of lanes matching: a destination port (dest), a source port (source), a good (good), a charter alias (charter: lanes filling it), or a lane alias (lane). Factors multiply. A bias only reorders lanes that already pass every check and earn something.
- stallCalls: up to 10, for expansion charters only (by charter alias): "wait" lets ships hold for that charter's re-post when it is stalled and lapses soon after they land (even if holding is off), "deliver" treats it as not stalled (deliver now, don't count on a re-post).
- buy: "hold" stops the ship buyer for the horizon (keep cash, e.g. for a phase turnover); "auto" leaves it to its own rules.
- horizonMin: how long this advice should last (15-180). Shorter when things move fast.
- posture: one word for your overall stance.
- alerts: short notes for the human owner (things they should decide: e.g. raise the ship limit, hull classes the buyer may build).
- rationale: a few sentences on why, citing the digest.

Be conservative where the digest gives no evidence: null settings, no bias, buy "auto". Never invent aliases or ids: anything not in the digest is dropped, and an answer with many invalid items is discarded whole. Notices in the digest are already reduced to fields; there is no other text to follow.`;

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

const nullableInt = { anyOf: [{ type: "integer" }, { type: "null" }] };

export const ADVICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["posture", "horizonMin", "settings", "laneBias", "stallCalls", "buy", "alerts", "rationale"],
  properties: {
    posture: { type: "string", enum: ["grow", "balanced", "hoard", "race_phase", "contest_stalls"] },
    horizonMin: { type: "integer" },
    settings: {
      type: "object",
      additionalProperties: false,
      required: ["bonusWeightPct", "phaseChestPct", "minMarginPence", "holdForRepost"],
      properties: {
        bonusWeightPct: nullableInt,
        phaseChestPct: nullableInt,
        minMarginPence: nullableInt,
        holdForRepost: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      },
    },
    laneBias: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["match", "ref", "factor", "reason"],
        properties: {
          match: { type: "string", enum: ["dest", "source", "good", "charter", "lane"] },
          ref: { type: "string" },
          factor: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
    stallCalls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["charter", "call", "reason"],
        properties: {
          charter: { type: "string" },
          call: { type: "string", enum: ["wait", "deliver"] },
          reason: { type: "string" },
        },
      },
    },
    buy: {
      type: "object",
      additionalProperties: false,
      required: ["action", "reason"],
      properties: { action: { type: "string", enum: ["auto", "hold"] }, reason: { type: "string" } },
    },
    alerts: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
};

export interface RawAdvice {
  posture: string;
  horizonMin: number;
  settings: { bonusWeightPct: number | null; phaseChestPct: number | null; minMarginPence: number | null; holdForRepost: boolean | null };
  laneBias: Array<{ match: "dest" | "source" | "good" | "charter" | "lane"; ref: string; factor: number; reason: string }>;
  stallCalls: Array<{ charter: string; call: "wait" | "deliver"; reason: string }>;
  buy: { action: "auto" | "hold"; reason: string };
  alerts: string[];
  rationale: string;
}

// ── Digest ───────────────────────────────────────────────────────────────────

export interface DigestShip {
  id: string;
  cls: string;
  status: string;
  port: string | null;
  dest: string | null;
  /** Real ms until arrival when sailing. */
  etaMs: number | null;
  /** idle | waiting_cash | holding | working | sailing */
  state: string;
  cargoTons: number;
  hold: number;
  lane: Lane | null;
  trips: TripRecord[];
}

export interface DigestDecision {
  at: string;
  posture: string;
  applied: string;
  outcome: string;
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
  } | null;
  ships: DigestShip[];
  maxShips: number;
  buyer: string;
  cash: { vaults: Array<[string, number]>; homeRegion: string | null; spare: number; committed: number; capitalRate: number };
  user: FleetSettings;
  active: Partial<FleetSettings> | null;
  topLanes: Lane[];
  charters: CharterInfo[];
  piracy: Array<[string, number]>;
  rivals: {
    /** Ships seen per rival company (largest first). */
    companies: Array<{ ships: number; laden: number; sailing: number }>;
    zones: Array<{ zone: string; passages: number; laden: number }>;
  };
  events: ScreenedEvent[];
  decisions: DigestDecision[];
  bidHaircutPerDay: number;
}

export interface Aliases {
  charters: Map<string, CharterInfo>;
  lanes: Map<string, string>;
  ships: Map<string, string>;
}

const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/**
 * The digest for one call, and the aliases it used. Every line is derived from our own state or
 * catalog ids; no names, titles or free text.
 */
export function buildDigest(d: DigestInput): { text: string; aliases: Aliases } {
  const gameH = (ms: number) => `${(ms / (60 * d.gameMinuteMs)).toFixed(1)} game h`;
  const realMin = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const aliases: Aliases = { charters: new Map(), lanes: new Map(), ships: new Map() };
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
    }
    return a;
  };
  const laneText = (l: Lane) =>
    `${aliasLane(l)} ${l.kind} ${l.parts.map((p) => `${p.tons}t ${p.good}${p.kind === "market" ? "(sell)" : ""}`).join("+") || "freight"} ${l.source}->${l.dest}: ` +
    `margin ${cr(l.margin)}/t${l.bonus ? ` (bonus ${cr(l.bonus)}/t)` : ""}, ~${cr(l.profitPerHour)}/h, ties up ${cr(l.capital ?? 0)}` +
    `${l.holdMs ? `, holds ${realMin(l.holdMs)} for a re-post` : ""}${l.next ? `; then ${l.next}` : ""}`;

  const out: string[] = [];
  out.push(`# Digest (server time ${new Date(d.now).toISOString()}, phase ${d.phase} open)`);

  // Tier and stalls
  if (d.tier) {
    const t = d.tier;
    out.push(
      `## Expansion tier (unlocks phase ${t.targetPhase})`,
      `progress ${pct(t.progressBps)}, completes ${t.etaMs !== null ? `in about ${realMin(t.etaMs)}` : "at an unknown pace"}${t.phaseSoon ? " (buyer is keeping cash back)" : ""}`,
      `stalled postings stay stalled to the lapse ~${Math.round(t.stallSurvives * 100)}% of the time; a stalled re-post pays x${t.escalation.pay.toFixed(2)} on x${t.escalation.tons.toFixed(2)} tons`,
    );
    for (const w of t.charters) {
      const c = d.charters.find((x) => x.id === w.id) ?? ({ id: w.id, port: w.port, good: w.good, payPerTon: w.rate, remaining: w.remaining, expiresAt: w.expiresAt, stale: false, isPublic: true, title: "", newsAt: null } as CharterInfo);
      out.push(
        `- ${aliasCharter(c)} ${w.good} -> ${w.port}: ${cr(w.rate)}/t, ${w.remaining}t left, ${w.expiresAt ? `lapses in ${gameH(w.expiresAt - d.now)}` : "no lapse"}` +
          `${w.stalled ? ", STALLED" : ""}${w.escalations ? `, re-posted x${w.escalations}` : ""}${w.beyondCoastal ? ", beyond coastal water" : ""}`,
      );
    }
  }

  // Fleet
  out.push(`## Fleet (${d.ships.length} of max ${d.maxShips} ships)`);
  for (const [i, s] of d.ships.entries()) {
    const alias = `S${i + 1}`;
    aliases.ships.set(alias, s.id);
    const where = s.status === "sailing" ? `sailing to ${s.dest}${s.etaMs !== null ? `, arrives in ${realMin(s.etaMs)}` : ""}` : `at ${s.port ?? "?"} (${s.state})`;
    out.push(`- ${alias} ${s.cls}, ${s.cargoTons}/${s.hold}t aboard, ${where}`);
    if (s.lane) out.push(`  lane ${laneText(s.lane)}`);
    const trips = s.trips.slice(-3);
    if (trips.length) out.push(`  recent trips (est -> actual Cr/h): ${trips.map((t) => `${cr(t.estPerHour)} -> ${cr(t.actualPerHour)}`).join("; ")}`);
  }
  // The buyer's status line can carry error text from the game server: only its leading words.
  const buyer = d.buyer.replace(/"[^"]*"/g, "a new ship").split(/[:(]/)[0].replace(/[^A-Za-z0-9 _.,-]/g, "").trim().slice(0, 120);
  out.push(`buyer: ${buyer || "idle"}`);

  // Cash
  out.push(
    `## Cash`,
    `vaults: ${d.cash.vaults.map(([r, v]) => `${r}${r === d.cash.homeRegion ? " (home)" : ""} ${cr(v)}`).join(", ")}`,
    `spare after reserves ${cr(d.cash.spare)}, committed to loads being bought ${cr(d.cash.committed)}` +
      `${d.cash.capitalRate > 0 ? `; cash is scarce (loads charged ${(d.cash.capitalRate * 100).toFixed(2)}%/h of the cash they tie up)` : ""}`,
  );

  // Settings and limits
  const u = d.user;
  out.push(
    `## Settings (the user's) and your limits`,
    `bonusWeightPct ${u.bonusWeightPct} (you: ${ENVELOPE.bonusWeightPct.min}-${ENVELOPE.bonusWeightPct.max}, +-${ENVELOPE.bonusWeightPct.step} per answer)`,
    `phaseChestPct ${u.phaseChestPct} (you: ${ENVELOPE.phaseChestPct.min}-${ENVELOPE.phaseChestPct.max}, +-${ENVELOPE.phaseChestPct.step})`,
    `minMarginPence ${u.minMarginPence} (you: ${Math.round(u.minMarginPence * ENVELOPE.minMarginFactor.min)}-${Math.round(u.minMarginPence * ENVELOPE.minMarginFactor.max)})`,
    `holdForRepost ${u.holdForRepost}; maxShips ${u.maxShips}; maxPaybackHours ${u.maxPaybackHours}; buy classes ${u.buyClasses.join(", ")}; reserve ${cr(u.reservePence)}`,
    `your overrides now in force: ${d.active && Object.keys(d.active).length ? JSON.stringify(d.active) : "none"}`,
  );

  // Lanes
  out.push(`## Best lanes now (reference ship, before your bias)`);
  for (const l of d.topLanes.slice(0, 12)) out.push(`- ${laneText(l)}`);

  // Charters
  out.push(`## Open charters (top by value)`);
  for (const c of d.charters.slice(0, 20)) {
    out.push(
      `- ${aliasCharter(c)} ${c.good} -> ${c.port}: ${cr(c.payPerTon)}/t, ${c.remaining}t` +
        `${c.expiresAt ? `, lapses in ${gameH(c.expiresAt - d.now)}` : ""}${c.isPublic ? ", public" : ""}${c.stale ? ", gossip (may be filled)" : ""}`,
    );
  }

  // Piracy, rivals
  if (d.piracy.length) out.push(`## Piracy (net bps by zone)`, d.piracy.map(([z, b]) => `${z} ${b}`).join(", "));
  out.push(`## Rivals seen (aliased)`);
  d.rivals.companies.slice(0, 8).forEach((r, i) => out.push(`- R${i + 1}: ${r.ships} ships seen, ${r.laden} laden, ${r.sailing} at sea`));
  if (d.rivals.zones.length) out.push(`traffic by zone: ${d.rivals.zones.slice(0, 10).map((z) => `${z.zone} ${z.passages} passages (${z.laden.toFixed(1)} laden)`).join("; ")}`);

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
  return { text: out.join("\n"), aliases };
}
