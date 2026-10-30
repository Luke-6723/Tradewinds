/**
 * News packets and Lloyd's news desk (guide 3.11, 3.16; the `newsPackets` setting). Pure logic, no calls: the manager reads the desks
 * board and the boards at its quays, builds the packet, runs her and posts the envelopes; this says when a packet pays, where she goes,
 * what her news is and what it asks.
 *
 * The game's terms: news travels only by ship. A sealed packet (`fleet/seal-dispatches`, packets only) keeps recording the quays she
 * calls at but posts nothing to the boards, so her news stays ours to seal into an envelope (`envelope/post` with `port_reports`,
 * narrowed to `report_port_ids`) at a quay where she lies. Lloyd's Coffee House buys an open envelope once it is a game hour old when it
 * carries news its board at that port doesn't hold yet (a report of another port newer than the board's) and its price is no more than
 * the news is worth to the house, which falls fast as the news ages; it spends only so much per seller and per region each game day,
 * and what it buys goes up on that board. `GET /v1/world/desks` (`desk: envelopes`) shows what the desk bought over a window.
 *
 * How the autopilot uses it (manager.ts runNews, courierTurn):
 *   - the desk's envelope buying is read every NEWS_CHECK_MS; a packet is worth one only when one packet's share of it (NEWS_DESK_SHARE
 *     of the house's spend a game day, and never more than one envelope a call at the desk's average price, half of them sold) beats her
 *     upkeep (her sprawl, 1 Cr a ton of oceanic hull, stores) and pays her hull back within maxPaybackHours (packetCase);
 *   - then ONE packet (Phase 2) is built under the buyer's rules (autoBuy, maxShips, the season, cash after loads and the fence, a yard
 *     where we have presence); a packet of ours already afloat is taken as the courier instead;
 *   - the courier is sealed and shuttles between the hubs (the busiest coffee houses) nearest her, the one called at longest ago and
 *     closest first (nextPort); at each she posts one envelope of the other ports she called at whose reports are newer than this
 *     board's (freshNews), priced at the desk's average per envelope times a step learned from our sales (newsPrice, learnStep), and
 *     withdraws ours there unsold after NEWS_STALE_GAME_H;
 *   - NEWS_TRIAL_GAME_DAYS after her first envelope, a courier whose envelope income over the trailing window doesn't cover her upkeep
 *     (or one that posted nothing NEWS_SILENT_GAME_DAYS after she was taken on) is given up and sold down the ship broker's ladder
 *     (housekeeping's retiring); then no packet is built or taken on again while packetCooldown says so (several real hours, and the
 *     rest of the season unless Lloyd's spend on envelopes doubles), so a desk too small for one is never tried over and over;
 *   - ordinary envelopes (any of our quays) are capped at what the market pays per envelope (ordinaryCap).
 */

import type { DeskBoard } from "../schema";

/** The desks board's window (game days) and how often it is read (real ms). */
export const NEWS_DESK_DAYS = 5;
export const NEWS_CHECK_MS = 10 * 60_000;
/** One packet's share of what Lloyd's spends a game day (it caps each seller; others sell too). */
export const NEWS_DESK_SHARE = 0.25;
/** Of the envelopes the courier posts, the share expected to sell at the desk's average price. */
export const NEWS_SELL_ODDS = 0.5;
/** Game hours a call takes in port (posting, the lock) on top of the passage. */
export const NEWS_PORT_GAME_H = 1;
/** The longest passage between calls (game hours) the courier sails. */
export const NEWS_MAX_LEG_GAME_H = 30;
/** News older than this (game hours) is never sealed (the house's price for it has fallen away). */
export const NEWS_MAX_AGE_GAME_H = 36;
/** A courier envelope unsold after this (game hours) is withdrawn (the house looks once it is a game hour old). */
export const NEWS_STALE_GAME_H = 6;
/** Life asked for a courier envelope (game hours). */
export const NEWS_LIFE_GAME_H = 8;
/** The price step: where it starts, its floor and ceiling, and its moves after a sale and an unsold envelope. */
export const NEWS_STEP_START = 1;
export const NEWS_STEP_MIN = 0.3;
export const NEWS_STEP_MAX = 1.5;
export const NEWS_STEP_UP = 1.1;
export const NEWS_STEP_DOWN = 0.8;
/** A courier envelope's price bounds (pence): 1 Cr to 500 Cr. */
export const NEWS_PRICE_MIN = 100;
export const NEWS_PRICE_MAX = 50_000;
/**
 * Game days a courier is given before her income is judged against her upkeep, and the window it is judged over: counted from her first
 * envelope posted (not her build or adoption: she may first sail out from a yard or finish a loaded passage, and her first call may
 * carry nothing).
 */
export const NEWS_TRIAL_GAME_DAYS = 3;
/** A courier that has posted nothing this many game days after she was taken on is given up all the same. */
export const NEWS_SILENT_GAME_DAYS = 2 * NEWS_TRIAL_GAME_DAYS;
/**
 * After a courier fails her trial (real ms): no packet is built or taken on again within NEWS_RETRY_MIN_MS, nor for the rest of that
 * season unless Lloyd's spend on envelopes has grown NEWS_RETRY_DESK_X-fold since (with no season end announced then, NEWS_RETRY_SEASON_MS
 * stands for the season).
 */
export const NEWS_RETRY_MIN_MS = 6 * 3_600_000;
export const NEWS_RETRY_SEASON_MS = 3 * 24 * 3_600_000;
export const NEWS_RETRY_DESK_X = 2;
/** Calls and sales kept. */
export const NEWS_CALLS_KEPT = 30;
export const NEWS_SALES_KEPT = 100;
/** The packet's class id (guide 3.11). */
export const PACKET_CLASS = "packet";

/** The envelopes desk as read (`at` local ms; pence; per game day). */
export interface DeskRead {
  at: number;
  days: number;
  /** What Lloyd's paid for envelopes a game day over the window, how many it bought, its average price per envelope. */
  perDay: number;
  count: number;
  avgPrice: number | null;
  /** Players' envelope trades between themselves: how many, average price. */
  playerCount: number;
  playerAvg: number | null;
}

/** The envelopes desk off the board, or null (not on it). */
export function envelopeDesk(board: DeskBoard, at: number): DeskRead | null {
  const d = board.desks.find((x) => x.desk === "envelopes");
  if (!d) return null;
  const days = Math.max(1, board.window_game_days || NEWS_DESK_DAYS);
  const bought = d.desk_bought ?? { count: 0, value_pence: 0 };
  const players = d.player_trades ?? { count: 0, value_pence: 0 };
  return {
    at,
    days,
    perDay: Math.max(0, bought.value_pence) / days,
    count: Math.max(0, bought.count),
    avgPrice: bought.count > 0 ? bought.value_pence / bought.count : null,
    playerCount: Math.max(0, players.count),
    playerAvg: players.count > 0 ? players.value_pence / players.count : null,
  };
}

/**
 * Whether one packet pays (pence a game day; real hours): her income (one packet's share of the desk's spend, never more than one
 * envelope a call at its average price, NEWS_SELL_ODDS of them sold) less her upkeep, and her hull paid back within the limit.
 */
export function packetCase(c: {
  desk: DeskRead;
  /** Game hours of the passage between the hubs she would shuttle between. */
  legGameH: number;
  upkeepPerDay: number;
  hullCost: number;
  paybackHours: number;
  /** Real hours in a game day. */
  realHoursPerGameDay: number;
}): { ok: boolean; incomePerDay: number; netPerDay: number; paybackHours: number | null; why: string } {
  const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
  const avg = c.desk.avgPrice ?? 0;
  const callsPerDay = 24 / (Math.max(1, c.legGameH) + NEWS_PORT_GAME_H);
  const incomePerDay = Math.max(0, Math.min(NEWS_DESK_SHARE * c.desk.perDay, callsPerDay * avg * NEWS_SELL_ODDS));
  const netPerDay = incomePerDay - Math.max(0, c.upkeepPerDay);
  if (c.desk.count === 0 || avg <= 0) return { ok: false, incomePerDay, netPerDay, paybackHours: null, why: `Lloyd's bought no envelopes over the last ${c.desk.days} game days` };
  if (netPerDay <= 0) return { ok: false, incomePerDay, netPerDay, paybackHours: null, why: `one packet's share (~${cr(incomePerDay)} a game day) wouldn't cover her upkeep (~${cr(c.upkeepPerDay)})` };
  const perHour = netPerDay / Math.max(1e-6, c.realHoursPerGameDay);
  const payback = c.hullCost / perHour;
  if (payback > c.paybackHours) return { ok: false, incomePerDay, netPerDay, paybackHours: payback, why: `her hull would pay back in ~${payback.toFixed(1)} h (limit ${c.paybackHours} h)` };
  return { ok: true, incomePerDay, netPerDay, paybackHours: payback, why: `~${cr(netPerDay)} a game day over her upkeep, the hull back in ~${payback.toFixed(1)} h` };
}

/** A courier envelope's price (pence): the desk's average per envelope times the step, within the bounds; null with no average. */
export function newsPrice(avg: number | null, step: number): number | null {
  if (avg === null || !(avg > 0)) return null;
  return Math.min(NEWS_PRICE_MAX, Math.max(NEWS_PRICE_MIN, Math.round((avg * step) / 100) * 100));
}

/** The step after a sale (up) or an envelope withdrawn unsold (down). */
export function learnStep(step: number, sold: boolean): number {
  const next = step * (sold ? NEWS_STEP_UP : NEWS_STEP_DOWN);
  return Math.min(NEWS_STEP_MAX, Math.max(NEWS_STEP_MIN, Math.round(next * 1000) / 1000));
}

/** What an ordinary envelope may ask at most (pence): what envelopes sell for, the house's average or players', the higher; null: unknown. */
export function ordinaryCap(desk: DeskRead | null): number | null {
  if (!desk) return null;
  const xs = [desk.avgPrice, desk.playerAvg].filter((x): x is number => x !== null && x > 0);
  return xs.length ? Math.max(NEWS_PRICE_MIN, Math.round(Math.max(...xs) / 100) * 100) : null;
}

/** A call of the courier (server ms she was first seen there). */
export interface NewsCall {
  port: string;
  at: number;
}

/**
 * The ports whose news the courier carries that the board here lacks: her latest call at each other port, younger than `maxAgeMs`,
 * newer than this board's report of it (`board`: subject port → its report's server ms; absent: the board has none). Newest first.
 */
export function freshNews(calls: readonly NewsCall[], board: ReadonlyMap<string, number>, here: string, now: number, maxAgeMs: number): NewsCall[] {
  const latest = new Map<string, number>();
  for (const c of calls) if (c.port !== here && c.at > (latest.get(c.port) ?? -Infinity)) latest.set(c.port, c.at);
  return [...latest]
    .filter(([p, at]) => now - at <= maxAgeMs && at > (board.get(p) ?? -Infinity))
    .map(([port, at]) => ({ port, at }))
    .sort((a, b) => b.at - a.at);
}

/**
 * Where the courier goes next: of the hubs in reach (`legs`: port → passage game hours), not where she is, the one whose call is
 * longest ago (capped at two game days: a port never called at counts as that) per hour of passage, the passage within NEWS_MAX_LEG_GAME_H.
 */
export function nextPort(legs: ReadonlyMap<string, number>, here: string, calls: readonly NewsCall[], now: number, gameHourMs: number): string | null {
  let best: { port: string; score: number } | null = null;
  for (const [port, h] of legs) {
    if (port === here || !(h > 0) || h > NEWS_MAX_LEG_GAME_H) continue;
    const last = calls.filter((c) => c.port === port).reduce((m, c) => Math.max(m, c.at), -Infinity);
    const since = Number.isFinite(last) ? Math.min(48, (now - last) / gameHourMs) : 48;
    const score = (1 + since) / (h + NEWS_PORT_GAME_H);
    if (!best || score > best.score) best = { port, score };
  }
  return best?.port ?? null;
}

export interface NewsStats {
  posted: number;
  sold: number;
  incomePence: number;
  withdrawn: number;
  built: number;
}

/** A courier that failed her trial (local ms), Lloyd's envelope spend a game day then (null: unread), the season's announced end then (server ms; null: none). */
export interface NewsFailure {
  at: number;
  perDay: number | null;
  seasonEndsAt: number | null;
}

/** The courier as the autopilot keeps it (saved). Times: local ms, but `calls` (server ms). */
export interface NewsMemory {
  /** The packet run as our courier, and since when. */
  packetId: string | null;
  since: number | null;
  /** Her first envelope posted as our courier (local ms; her trial runs from it; absent or null: none yet). */
  trialFrom?: number | null;
  /** The price step learned from our courier envelopes. */
  step: number;
  /** The courier's calls, and the ship they are hers (a new courier starts with none: another's calls are no news of hers). */
  calls: NewsCall[];
  callsShip?: string | null;
  /** Courier envelopes sold (local ms, pence), for the trailing judgement. */
  sales: Array<[number, number]>;
  stats: NewsStats;
  /** The courier given up (her income didn't cover her upkeep): to be sold, never couriering again unless the setting is turned off and on. */
  givenUp: { shipId: string; at: number; why: string } | null;
  /** The last courier that failed her trial: no packet built or taken on again while packetCooldown says so (whatever the switch does). */
  failed?: NewsFailure | null;
}

export function emptyNews(): NewsMemory {
  return { packetId: null, since: null, step: NEWS_STEP_START, calls: [], sales: [], stats: { posted: 0, sold: 0, incomePence: 0, withdrawn: 0, built: 0 }, givenUp: null };
}

/**
 * Why no packet may be built or taken on as our courier now after one failed her trial (null: one may): within NEWS_RETRY_MIN_MS of the
 * failure, or in the same season (the season end announced then not yet reached; none announced: NEWS_RETRY_SEASON_MS) unless Lloyd's
 * envelope spend a game day (read lately; null: not known) has grown NEWS_RETRY_DESK_X-fold. `now` local ms, `serverNow` server ms.
 */
export function packetCooldown(f: NewsFailure | null | undefined, c: { now: number; serverNow: number; perDay: number | null }): string | null {
  if (!f) return null;
  const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
  const ago = c.now - f.at;
  if (ago < NEWS_RETRY_MIN_MS) return `a news packet failed her trial ${(ago / 3_600_000).toFixed(1)} real hours ago: none again for ${NEWS_RETRY_MIN_MS / 3_600_000} real hours`;
  const sameSeason = f.seasonEndsAt !== null ? c.serverNow < f.seasonEndsAt : ago < NEWS_RETRY_SEASON_MS;
  if (!sameSeason) return null;
  if (f.perDay !== null && f.perDay > 0 && c.perDay !== null && c.perDay >= NEWS_RETRY_DESK_X * f.perDay) return null;
  return (
    `a news packet failed her trial this season: none again unless Lloyd's spend on envelopes grows ${NEWS_RETRY_DESK_X}-fold` +
    (f.perDay !== null ? ` (~${cr(f.perDay)} a game day then${c.perDay !== null ? `, ~${cr(c.perDay)} now` : ""})` : "")
  );
}

export function restoreNews(s: Partial<NewsMemory> | undefined): NewsMemory {
  const m = emptyNews();
  if (!s) return m;
  if (typeof s.packetId === "string") m.packetId = s.packetId;
  if (Number.isFinite(s.since)) m.since = s.since!;
  if (Number.isFinite(s.step)) m.step = Math.min(NEWS_STEP_MAX, Math.max(NEWS_STEP_MIN, s.step!));
  m.calls = (Array.isArray(s.calls) ? s.calls : []).filter((c) => c && typeof c.port === "string" && Number.isFinite(c.at)).slice(-NEWS_CALLS_KEPT);
  m.sales = (Array.isArray(s.sales) ? s.sales : []).filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])).slice(-NEWS_SALES_KEPT);
  for (const k of Object.keys(m.stats) as (keyof NewsStats)[]) {
    const v = s.stats?.[k];
    if (typeof v === "number" && Number.isFinite(v)) m.stats[k] = v;
  }
  const g = s.givenUp;
  if (g && typeof g.shipId === "string" && Number.isFinite(g.at)) m.givenUp = { shipId: g.shipId, at: g.at, why: typeof g.why === "string" ? g.why : "" };
  if (Number.isFinite(s.trialFrom)) m.trialFrom = s.trialFrom;
  // An older save's courier: her trial ran from when she was taken on (as it did then), never judged as one that posted nothing.
  else if (s.trialFrom === undefined && m.packetId !== null && m.since !== null) m.trialFrom = m.since;
  if (typeof s.callsShip === "string") m.callsShip = s.callsShip;
  // An older save: its calls are its courier's.
  else if (s.callsShip === undefined && m.packetId !== null) m.callsShip = m.packetId;
  const f = s.failed;
  if (f && Number.isFinite(f.at)) m.failed = { at: f.at, perDay: Number.isFinite(f.perDay) ? f.perDay : null, seasonEndsAt: Number.isFinite(f.seasonEndsAt) ? f.seasonEndsAt : null };
  return m;
}

/** News packets for the panel and the digest. Pence; times ISO. */
export interface NewsReport {
  /** The switch in force. */
  enabled: boolean;
  /** Why no packet is built or run now (null: one may be). */
  blocked: string | null;
  action: string;
  checkedAt: string | null;
  /** The envelopes desk as last read: Lloyd's spend a game day, envelopes bought, average price; players' trades. */
  desk: { days: number; perDayPence: number; bought: number; avgPence: number | null; playerTrades: number; playerAvgPence: number | null; readAt: string } | null;
  /** The case for one packet as last weighed. */
  case: { ok: boolean; incomePerDayPence: number; upkeepPerDayPence: number; netPerDayPence: number; paybackHours: number | null; why: string } | null;
  /** Our courier: the ship, since when, where she lies or is bound, sealed, her calls (newest last), income over the trailing window. */
  courier: { shipId: string; ship: string; since: string | null; port: string | null; dest: string | null; sealed: boolean; calls: Array<{ port: string; at: string }>; trailingIncomePence: number; trailingUpkeepPence: number } | null;
  /** The price step and the price an envelope of hers asks now; the cap on ordinary envelopes. */
  step: number;
  pricePence: number | null;
  ordinaryCapPence: number | null;
  openEnvelopes: number;
  givenUp: { ship: string; at: string; why: string } | null;
  stats: NewsStats;
}
