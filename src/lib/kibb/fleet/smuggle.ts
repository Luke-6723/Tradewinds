/**
 * The Free Trade (guide 3.18), the smuggling mode's arithmetic: what a want is worth by the time our goods get there, the
 * odds of a seizure (a conservative prior, learned from our own runs and kept across restarts), the value test, and the
 * Crown's attention. Pure: no I/O. The manager (runSmuggling, smuggleTurn) acts on it; the dashboard shows it.
 *
 * What the guide says, and so what this assumes:
 * - At sea only patrols search, in the zones they patrol: a route through zones with no patrol suppression is safe at sea
 *   (the autopilot sails only such routes, checked again before departing). A patrol funded on the route while she is under
 *   way is what the per-run prior stands for.
 * - In an ordinary port a ship lying there with contraband aboard may be searched at any time, berthed more than in the
 *   roadstead; a cove is never searched. Odds are never published: a prior per game hour lying in port, learned.
 * - Faster is safer, busier is riskier: a company that runs goods ashore often draws the Crown's attention for a while.
 * - Caught: the ship and everything aboard are forfeit, insurance pays nothing (and Lloyd's never covers contraband), the
 *   conviction goes on the public credit record.
 */

/** Most of our ships smuggling at once, and the fewest ships the fleet must have for one to be spared (never the only one). */
export const SMUGGLE_MAX_SHIPS = 1;
export const SMUGGLE_MIN_FLEET = 2;
/** Default most tons a run buys, and most it spends on goods (pence): small loads. */
export const SMUGGLE_DEFAULT_TONS = 5;
export const SMUGGLE_DEFAULT_PENCE = 300_000;
/** A cove's board entry fresh enough to buy on (game hours since the crew saw it), and its least multiple (bps of base). */
export const WANT_MAX_AGE_GAME_H = 24;
export const WANT_MIN_MULTIPLE_BPS = 30_000;
/** A want our own ship saw live, fresh enough to sail for with goods already aboard (game hours). */
export const LIVE_WANT_MAX_AGE_GAME_H = 12;
/** Lying in the roadstead of a wanting port with the goods aboard: a live want still run ashore at once from this multiple. */
export const RUN_MIN_MULTIPLE_BPS = 12_000;
/** A want is taken to be gone this long after it was seen (game hours: the guide only says wants fade, then are gone). */
export const WANT_LIFE_GAME_H = 72;
/** Share of a want's premium over base taken to fade each game day. */
export const WANT_FADE_PER_GAME_DAY = 0.35;
/** Goods that find no want are taken to fetch this share of base back at a cove (players' bids: a floor, not a forecast). */
export const COVE_RESALE_SHARE = 0.5;
/** The value test: the expected gain must be at least this many times the expected loss. */
export const EV_LOSS_X = 2;
/** Prior odds of a seizure per run (what we can't see: a patrol funded on the route under way, the Crown's attention). */
export const PRIOR_PER_RUN = 0.03;
/** Prior odds of a search taking us per game hour lying in an ordinary port's roadstead with contraband aboard. */
export const PRIOR_PER_PORT_GAME_H = 0.01;
/** A berthed ship is searched more than one in the roadstead: her hours count this many times. */
export const BERTHED_FACTOR = 3;
/** Prior strength (pseudo-runs, pseudo game hours lain), and the floor learning never takes a rate under (share of its prior). */
export const PRIOR_RUNS = 20;
export const PRIOR_PORT_H = 200;
export const MODEL_FLOOR_SHARE = 0.5;
/** A run ashore takes "a few game hours": taken as this until our own runs show (game hours). */
export const RUN_PRIOR_GAME_H = 4;
/** On arrival a free berth takes the ship: the base lock she lies berthed before she may leave it (game hours). */
export const ARRIVAL_BERTH_GAME_H = 0.5;
/** Attention: runs ashore within this window (game hours) raise the port hazard by ATTENTION_STEP each and space the next run. */
export const ATTENTION_WINDOW_GAME_H = 72;
export const ATTENTION_STEP = 0.5;
/** The least gap between runs (game hours), doubled for each run in the window, at most the cap. */
export const ATTENTION_GAP_GAME_H = 12;
export const ATTENTION_GAP_MAX_GAME_H = 96;
/** Stores carried beyond the passages a run plans (game days of eating in port), since a smuggler may not stock up elsewhere. */
export const SMUGGLE_STORES_DAYS = 3;

/** The learned seizure model (persisted with the fleet's progress). */
export interface SeizureModel {
  /** Voyages with contraband aboard that ended (arrived somewhere, or in a seizure at sea). */
  runs: number;
  /** Game hours lain in ordinary ports with contraband aboard, berthed hours counted BERTHED_FACTOR times. */
  portHours: number;
  seizedInPort: number;
  seizedAtSea: number;
  /** Game hours our runs ashore took (the last 20). */
  runHours: number[];
}

export const EMPTY_MODEL: SeizureModel = { runs: 0, portHours: 0, seizedInPort: 0, seizedAtSea: 0, runHours: [] };

/** A model read back from a save, every field checked (a bad one is the empty model's). */
export function restoreModel(m: Partial<SeizureModel> | null | undefined): SeizureModel {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    runs: n(m?.runs),
    portHours: n(m?.portHours),
    seizedInPort: n(m?.seizedInPort),
    seizedAtSea: n(m?.seizedAtSea),
    runHours: Array.isArray(m?.runHours) ? m!.runHours.filter((h) => typeof h === "number" && Number.isFinite(h) && h > 0).slice(-20) : [],
  };
}

/** Odds of a search taking us per (weighted) game hour lying in an ordinary port: the prior, moved by what we have lived through. */
export function portHazard(m: SeizureModel): number {
  const learned = (PRIOR_PER_PORT_GAME_H * PRIOR_PORT_H + m.seizedInPort) / (PRIOR_PORT_H + m.portHours);
  return Math.max(PRIOR_PER_PORT_GAME_H * MODEL_FLOOR_SHARE, learned);
}

/** Odds of a seizure per run beyond the time in port (a patrol on the route met under way, attention we can't see). */
export function runHazard(m: SeizureModel): number {
  const learned = (PRIOR_PER_RUN * PRIOR_RUNS + m.seizedAtSea) / (PRIOR_RUNS + m.runs);
  return Math.max(PRIOR_PER_RUN * MODEL_FLOOR_SHARE, learned);
}

/** How long a run ashore takes (game hours): the median of ours, else the prior. */
export function runGameHours(m: SeizureModel): number {
  const h = [...m.runHours].sort((a, b) => a - b);
  return h.length ? h[Math.floor(h.length / 2)] : RUN_PRIOR_GAME_H;
}

/** The port hazard's multiplier for the Crown's attention: `recent` runs ashore in the window. */
export function attentionFactor(recent: number): number {
  return 1 + ATTENTION_STEP * Math.max(0, recent);
}

/** The least gap before the next run (game hours) after `recent` runs ashore in the window (none: no gap). */
export function attentionGapGameH(recent: number): number {
  return recent <= 0 ? 0 : Math.min(ATTENTION_GAP_MAX_GAME_H, ATTENTION_GAP_GAME_H * 2 ** (recent - 1));
}

/**
 * Odds a run ends in a seizure: the per-run odds, and the port hazard over the hours lying berthed (counted BERTHED_FACTOR
 * times) and in the roadstead, raised for the Crown's attention. At sea nothing, on routes with no patrol (the only ones sailed).
 */
export function seizureOdds(m: SeizureModel, o: { berthH: number; roadH: number; recent: number }): number {
  const hours = Math.max(0, o.berthH) * BERTHED_FACTOR + Math.max(0, o.roadH);
  const port = 1 - Math.exp(-portHazard(m) * attentionFactor(o.recent) * hours);
  return 1 - (1 - runHazard(m)) * (1 - port);
}

/**
 * What a ton landed fetches (pence): a want seen at `multipleBps` of base, `ageGameH` old when we would land (it fades, and
 * may be gone: then the goods are sold back at a cove for COVE_RESALE_SHARE of base), each ton walking it down towards
 * base over what it still takes (`remaining`; unknown, a board's report: our own tons are taken to walk it all the way).
 */
export function wantValue(o: { basePence: number; multipleBps: number; ageGameH: number; tons: number; remaining: number | null }): {
  perTon: number;
  survive: number;
  multiple: number;
} {
  const age = Math.max(0, o.ageGameH);
  const survive = Math.max(0, 1 - age / WANT_LIFE_GAME_H);
  const multiple = 1 + (Math.max(10_000, o.multipleBps) / 10_000 - 1) * (1 - WANT_FADE_PER_GAME_DAY) ** (age / 24);
  const room = o.remaining !== null && o.remaining > 0 ? o.remaining : Math.max(1, o.tons);
  const walk = Math.min(1, Math.max(0, o.tons) / (2 * room));
  const landed = 1 + (multiple - 1) * (1 - walk);
  const perTon = o.basePence * (survive * landed + (1 - survive) * COVE_RESALE_SHARE);
  return { perTon: Math.round(perTon), survive, multiple };
}

/**
 * The value test for a run: expected gain = P(ok) × proceeds − goods − P(caught) × ship − the ship's time; expected loss =
 * P(caught) × (ship + goods). It passes when the gain is positive and at least EV_LOSS_X times the loss. Goods already
 * aboard (a sunk cost) pass `goods` 0 and compare destinations on the same footing.
 */
export function smuggleCase(o: { proceeds: number; goods: number; shipValue: number; p: number; timeCost: number }): {
  gain: number;
  loss: number;
  ok: boolean;
} {
  const p = Math.min(1, Math.max(0, o.p));
  const gain = (1 - p) * o.proceeds - o.goods - p * o.shipValue - o.timeCost;
  const loss = p * (o.shipValue + o.goods);
  return { gain: Math.round(gain), loss: Math.round(loss), ok: gain > 0 && gain >= EV_LOSS_X * loss };
}

/** The Underworld page's view of the company key (the dashboard's /api/kibb/company/underworld). */
export interface UnderworldAccess {
  underworld: boolean;
  scopes: string[];
  keyExpiresAt: string | null;
  /** Read from the game just now (false: as the store recorded them; the game couldn't be asked). */
  verified: boolean;
}
