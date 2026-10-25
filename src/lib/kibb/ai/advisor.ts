/**
 * The AI advisor: Claude as the fleet's strategist. Every 30 minutes (15 near a phase turnover), and
 * soon after a phase change, a stall escalation, a lost ship or a trip far below its estimate, it
 * reads a digest of the fleet and the world (digest.ts) and answers with directives (directives.ts):
 * any setting but its own for the horizon (within ranges, spend ceilings the user's, the reserve only
 * raised), bans and a bias on lanes, per-charter stall calls, orders to single ships (a lane, a
 * charter, a port, hold, release), the buyer (hold, one build, classes forbidden), marques or
 * patrols within the marque budget, and money orders (borrow for a load or a hull, repay a loan early,
 * build a commission to order) through the autopilot's own checks.
 *
 * Off by default. In "shadow" mode it advises and logs but changes nothing; in "live" the directives
 * apply until their horizon lapses. Every check in the autopilot still runs: settings are clamped
 * again wherever they are read, bans and orders go through the planner, loading and sailing as ever
 * (anything unsafe or impossible is refused and reported back as a status code), a bias only reorders
 * lanes that already pass, and a stall call only works on a posting that is stalled. An issued
 * marque or patrol can't be withdrawn: it runs its term (at most the horizon).
 *
 * Safeguards: spend caps per UTC day and in total (a call is skipped if its worst case could pass
 * one), a tripwire that clears the directives if half the fleet sits idle (or held) for 20 minutes
 * under them, and auto-demotion to shadow when trips made under its advice earn clearly less than
 * without. Free text never reaches the strategist: notices go through the Haiku screen (screen.ts)
 * first, and its orders' outcomes come back as fixed codes.
 */

import { randomUUID } from "node:crypto";
import type { FleetSettings } from "../fleet/manager";
import type { Bans, Lane } from "../fleet/planner";
import type { World } from "../fleet/world";
import { mongoDb } from "../mongo";
import { AI_MODEL_NAMES, callStructured, ClaudeCallError, claudeConfigured, describeError, notBilled, worstCaseUsd, type AiEffort } from "./claude";
import { ADVICE_SCHEMA, buildDigest, systemPrompt, type Aliases, type DigestInput, type RawAdvice } from "./digest";
import {
  BIAS_MAX,
  BIAS_MIN,
  bansOf,
  normalizeActive,
  OVERRIDE_KEYS,
  sameSetting,
  validateAnswer,
  type Active,
  type BanKind,
  type BuildOrder,
  type FinanceOrder,
  type NavalOrder,
  type OrderCode,
  type OrderStatus,
  type OverrideKey,
  type OverrideSettings,
  type ShipOrder,
  type ShipOrderKind,
  type StoredActive,
  type ValidateCtx,
} from "./directives";
import { screenEvents, type RawEvent, type ScreenedEvent } from "./screen";

export type AiMode = "off" | "shadow" | "live";
export const AI_MODES: AiMode[] = ["off", "shadow", "live"];

/** Near a phase turnover the routine cadence (a setting) is halved, down to this. */
const ROUTINE_MIN_MS = 15 * 60_000;
/** A quiet stretch: at most this many routine calls in a row are skipped for an unchanged picture. */
const MAX_SKIPS = 3;
/** The system prompt is cached (one hour) only when calls come often enough to hit it. */
const CACHE_WHEN_UNDER_MS = 50 * 60_000;
/** Soonest a triggered call follows the last one, and the most calls in any hour. */
const MIN_GAP_MS = 5 * 60_000;
const MAX_PER_HOUR = 4;
/** An answer computed on a digest older than this, or across a phase change, is discarded. */
const STALE_MS = 10 * 60_000;
/** More than this share of an answer's items invalid: the whole answer is discarded. */
const MAX_INVALID = 0.3;
/** Room for the answer (thinking included) by effort: thinking is most of a call's cost (the worst case reserved follows it). */
const MAX_TOKENS: Record<AiEffort, number> = { low: 7_500, medium: 11_500, high: 17_500 };
/** Idle tripwire: this share of the fleet idle under live directives for this long clears them. */
const TRIPWIRE_IDLE = 0.5;
const TRIPWIRE_MS = 20 * 60_000;
/** Auto-demotion: with this many trips each way, advice earning under this ratio goes back to shadow. */
const DEMOTE_MIN_TRIPS = 10;
const DEMOTE_RATIO = 0.8;
const TRIP_WINDOW = 40;
/** Screening: at most one Haiku call a minute, a few notices kept for the digest. */
const SCREEN_GAP_MS = 60_000;
const RAW_QUEUE_MAX = 20;
const EVENTS_KEPT = 20;
const DECISIONS_KEPT = 20;

export interface AiDecision {
  id: string;
  at: string;
  trigger: string;
  mode: "live" | "shadow";
  model: string;
  costUsd: number;
  posture: string;
  horizonMin: number;
  rationale: string;
  settings: OverrideSettings;
  biases: Array<{ label: string; factor: number; reason: string }>;
  stallCalls: Array<{ label: string; call: "wait" | "deliver"; reason: string }>;
  buy: { action: "auto" | "hold" | "build"; reason: string };
  alerts: string[];
  /** Items of the answer dropped as invalid (unknown alias or id, out of scope). */
  dropped: number;
  status: "applied" | "shadow" | "discarded" | "expired" | "cleared" | "tripwire" | "superseded" | "demoted";
  note?: string;
  /** Trips finished while it was in force (live), and their profit. */
  trips: number;
  profitPence: number;
  // Absent on decisions made before these existed.
  settingReasons?: Partial<Record<OverrideKey, string>>;
  avoid?: Array<{ kind: BanKind; label: string; reason: string }>;
  /** Live: kept up to date with what became of each. */
  shipOrders?: ShipOrder[];
  build?: BuildOrder | null;
  forbid?: string[];
  naval?: NavalOrder[];
  /** Marques and patrols it issued (pence): they run their term even after it is cleared. */
  navalSpentPence?: number;
  /** Money orders (borrow, repay, accept a commission) and what became of them. */
  finance?: FinanceOrder[];
}

export interface AiReport {
  mode: AiMode;
  /** What actually runs: live advice demoted to shadow shows as shadow. */
  effective: AiMode;
  demoted: boolean;
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  spend: { day: string; today: number; total: number; dailyCap: number; totalCap: number };
  /** What runs it: model name, effort, minutes between routine calls; the average cost of its answers. */
  model: string;
  effort: AiEffort;
  intervalMin: number;
  avgCostUsd: number | null;
  /** Routine calls skipped because nothing important changed since the last answer. */
  skipped: number;
  /** Every directive in force, with the reason it was given and (orders) what became of it. */
  active: {
    decisionId: string;
    until: string;
    settings: Array<{ key: string; from: unknown; to: unknown; reason: string }>;
    avoid: Array<{ kind: BanKind; label: string; reason: string }>;
    biases: Array<{ label: string; factor: number; reason: string }>;
    stallCalls: Array<{ label: string; call: "wait" | "deliver"; reason: string }>;
    shipOrders: Array<{ shipId: string; order: ShipOrderKind; label: string; status: OrderStatus; code?: OrderCode; note?: string; reason: string }>;
    buy: { hold: string | null; build: BuildOrder | null; forbid: string[] };
    naval: NavalOrder[];
    /** Absent from reports of managers older than money orders. */
    finance?: FinanceOrder[];
  } | null;
  decisions: AiDecision[];
  events: ScreenedEvent[];
  uplift: { aiTrips: number; aiPerHour: number | null; baseTrips: number; basePerHour: number | null };
}

export interface AdvisorSnapshot {
  spend: { day: string; today: number; total: number };
  decisions: AiDecision[];
  active: StoredActive | null;
  demoted: boolean;
  aiTrips: number[];
  baseTrips: number[];
  events: ScreenedEvent[];
  lastRunAt: number;
}

/** What the advisor needs from the fleet manager. */
export interface AdvisorHost {
  readonly world: World;
  /** The user's own settings (without the advisor's overrides). */
  userSettings(): FleetSettings;
  /** The digest's inputs from the fleet's current state (events, decisions and the directives in force are filled in here). */
  digestInput(): Omit<DigestInput, "events" | "decisions" | "inForce">;
  /** What an answer is validated against: the user's settings, the key's scopes, the fleet, the zones, naval spend. */
  limits(): ValidateCtx;
  /** Share of the fleet idle for want of a lane, or held by an AI order. */
  idleShare(): number;
  log(msg: string): void;
  persist(now?: boolean): void;
  /** The directives in force changed (new, cleared, lapsed in part): settings, world flags, lanes and orders follow. */
  directivesChanged(): void;
  companyId(): string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One past decision as the digest recalls it: what it did and (status codes only) what became of its orders. */
function memory(d: AiDecision): string {
  const orders = d.shipOrders ?? [];
  const tally = (xs: Array<{ status: string }>) => {
    const n = new Map<string, number>();
    for (const x of xs) n.set(x.status, (n.get(x.status) ?? 0) + 1);
    return [...n].map(([s, k]) => `${k} ${s}`).join(", ");
  };
  const naval = d.naval ?? [];
  const money = d.finance ?? [];
  return [
    d.status,
    Object.keys(d.settings).length ? `settings ${JSON.stringify(d.settings)}` : "",
    d.biases.length ? plural(d.biases.length, "bias", "biases") : "",
    d.avoid?.length ? plural(d.avoid.length, "ban") : "",
    orders.length ? `${plural(orders.length, "ship order")} (${tally(orders)})` : "",
    d.buy.action === "hold" ? "buy held" : "",
    d.build ? `build ${d.build.cls}@${d.build.yard} (${d.build.status}${d.build.code ? `: ${d.build.code}` : ""})` : "",
    d.forbid?.length ? `forbid ${d.forbid.join(" ")}` : "",
    naval.length ? `naval ${tally(naval)}${d.navalSpentPence ? `, ${cr(d.navalSpentPence)} spent` : ""}` : "",
    money.length ? `money ${money.map((o) => `${o.kind} ${o.status}${o.code ? `: ${o.code}` : ""}`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export class Advisor {
  private spend = { day: today(), today: 0, total: 0 };
  private decisions: AiDecision[] = [];
  private active: Active | null = null;
  private demoted = false;
  private aiTrips: number[] = [];
  private baseTrips: number[] = [];
  private events: ScreenedEvent[] = [];
  private raw: RawEvent[] = [];
  private running = false;
  private screening = false;
  private lastRunAt = 0;
  private lastScreenAt = 0;
  private nextRunAt = 0;
  private pending: string | null = null;
  private calls: number[] = [];
  private lastError: string | null = null;
  private idleSince: number | null = null;
  private lastMode: AiMode = "off";
  /** Set once the autopilot stops: nothing in flight may apply, log or save after that. */
  private stopped = false;
  /** The picture the last answer was given (see fingerprint), and routine calls skipped since. */
  private lastPrint: string | null = null;
  private skips = 0;
  private skippedTotal = 0;
  private abort = new AbortController();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly host: AdvisorHost) {}

  // ── Mode ────────────────────────────────────────────────────────────────────

  private get mode(): AiMode {
    return this.host.userSettings().ai;
  }

  /** Live demoted to shadow by its own record runs as shadow until the user switches it to live again. */
  get effective(): AiMode {
    const m = this.mode;
    return m === "live" && this.demoted ? "shadow" : m;
  }

  /**
   * The user changed settings: a fresh switch to live clears a demotion; off clears what's in
   * force; an override of a setting the user just changed lapses (theirs wins).
   */
  settingsChanged(prev: FleetSettings, next: FleetSettings): void {
    if (next.ai === "live" && prev.ai !== "live" && this.demoted) {
      this.demoted = false;
      this.host.persist(true);
    }
    if (next.ai !== "off" && prev.ai === "off") this.nextRunAt = 0;
    // A new mode gets a fresh look, not a skipped one.
    if (next.ai !== prev.ai) {
      this.lastPrint = null;
      this.skips = 0;
    }
    if (next.aiIntervalMin !== prev.aiIntervalMin && this.lastRunAt) this.nextRunAt = this.lastRunAt + next.aiIntervalMin * 60_000;
    if (next.ai !== "live" && this.active) this.clear("cleared", `AI switched to ${next.ai}`);
    // The user changed a setting the AI had overridden: theirs wins for the rest of this advice (a
    // forbidden class list goes with their class list).
    const a = this.active;
    const gone = a ? OVERRIDE_KEYS.filter((k) => k in a.settings && !sameSetting(prev[k], next[k])) : [];
    const forbidGone = !!a && a.forbid.length > 0 && !sameSetting(prev.buyClasses, next.buyClasses);
    if (a && (gone.length || forbidGone)) {
      const settings = { ...a.settings };
      const base = { ...a.base };
      for (const k of gone) {
        delete settings[k];
        delete base[k];
      }
      a.settings = settings;
      a.base = base;
      if (forbidGone) a.forbid = [];
      this.host.directivesChanged();
      this.host.persist(true);
    }
    this.lastMode = next.ai;
  }

  /** The autopilot is stopping: cancel calls in flight and wait for them; nothing applies after this. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // ── What the autopilot reads ───────────────────────────────────────────────

  private inForce(): Active | null {
    if (!this.active || this.effective !== "live") return null;
    return Date.now() < this.active.until ? this.active : null;
  }

  /**
   * Setting overrides in force (validated when applied; the manager clamps them again), or null. One the user
   * has since changed no longer applies.
   */
  overrides(): OverrideSettings | null {
    const a = this.inForce();
    if (!a) return null;
    const user = this.host.userSettings();
    const out: OverrideSettings = {};
    for (const k of OVERRIDE_KEYS) {
      if (!(k in a.settings) || !(k in a.base) || !sameSetting(a.base[k], user[k])) continue;
      (out as Record<string, unknown>)[k] = a.settings[k];
    }
    return Object.keys(out).length ? out : null;
  }

  hasBias(): boolean {
    return (this.inForce()?.biases.length ?? 0) > 0;
  }

  /** The product of the biases matching this lane (1 with none). */
  bias(lane: Lane): number {
    const a = this.inForce();
    if (!a) return 1;
    const w = this.host.world;
    let f = 1;
    for (const b of a.biases) {
      const hit =
        b.match === "dest"
          ? lane.dest === b.ref
          : b.match === "source"
            ? lane.source === b.ref
            : b.match === "port"
              ? lane.source === b.ref || lane.dest === b.ref
              : b.match === "zone"
                ? !!lane.zones?.includes(b.ref)
                : b.match === "good"
                  ? lane.good === b.ref || lane.parts.some((p) => p.good === b.ref)
                  : b.match === "charter"
                    ? // Both sides followed to the posting that now stands for them (it may have re-posted).
                      lane.fills.some(([id]) => w.currentId(id) === w.currentId(b.ref))
                    : lane.key === b.ref;
      if (hit) f *= b.factor;
    }
    return Math.min(BIAS_MAX, Math.max(BIAS_MIN, f));
  }

  /** The stall call in force on the expansion charter at this port for this good, if any. */
  stallCall(port: string, good: string): "wait" | "deliver" | undefined {
    return this.inForce()?.stallCalls.find((s) => s.key === `${port}|${good}`)?.call;
  }

  /** Why the buyer should hold, or null. */
  buyHold(): string | null {
    return this.inForce()?.buyHold ?? null;
  }

  /** The bans in force (new plans only), or null. */
  bans(): Bans | null {
    const a = this.inForce();
    return a ? bansOf(a.avoid, (id) => this.host.world.currentId(id)) : null;
  }

  /** The order in force for this ship, unless it is done or was refused. */
  shipOrder(shipId: string): ShipOrder | undefined {
    return this.inForce()?.shipOrders.find((o) => o.ship === shipId && o.status !== "done" && o.status !== "refused" && o.status !== "lapsed");
  }

  /** Ships an order in force holds in the roadstead. */
  heldShips(): Set<string> {
    return new Set((this.inForce()?.shipOrders ?? []).filter((o) => o.order === "hold" && o.status !== "done" && o.status !== "refused").map((o) => o.ship));
  }

  /** The build order in force, unless it is done or was refused. */
  buildOrder(): BuildOrder | null {
    const b = this.inForce()?.build ?? null;
    return b && b.status !== "done" && b.status !== "refused" && b.status !== "lapsed" ? b : null;
  }

  /** Money orders in force still to act on (borrow, repay, accept a commission): not done, refused or lapsed. */
  financeOrders(): FinanceOrder[] {
    return (this.inForce()?.finance ?? []).filter((o) => o.status !== "done" && o.status !== "refused" && o.status !== "lapsed");
  }

  /** What became of a money order (true when that changed it), only while that very order is in force. */
  noteFinance(order: FinanceOrder, status: OrderStatus, code?: OrderCode, note?: string): boolean {
    const o = this.inForce()?.finance.find((x) => x === order);
    if (!o || (o.status === status && o.code === code)) return false;
    Object.assign(o, { status, code, note });
    this.mirror();
    return true;
  }

  /** Marques and patrols still to issue, and those whose outcome is unknown (to reconcile, never to send again). */
  pendingNaval(): NavalOrder[] {
    return (this.inForce()?.naval ?? []).filter((n) => n.status === "pending" || n.status === "unknown");
  }

  /**
   * Expected cost (pence) of marques and patrols sent at server time `since` or later whose call had no answer and
   * that haven't been found among ours yet (in force or not): they may have been paid for, so they count as spent.
   */
  unknownNavalPence(since: number): number {
    const seen = new Map<string, NavalOrder>();
    for (const n of [...this.decisions.flatMap((d) => d.naval ?? []), ...(this.active?.naval ?? [])]) seen.set(n.id, n);
    let pence = 0;
    for (const n of seen.values()) if (n.status === "unknown" && (n.sentAt ?? 0) >= since) pence += n.costPence;
    return pence;
  }

  /** Local ms the directives in force lapse, or null. */
  inForceUntil(): number | null {
    return this.inForce()?.until ?? null;
  }

  /**
   * What became of a ship's order (true when that changed it), only while that very order is in force: an outcome
   * judged on an older answer's order never lands on a newer one for the same ship. Kept on the decision too.
   */
  noteOrder(order: ShipOrder, status: OrderStatus, code?: OrderCode, note?: string): boolean {
    const o = this.inForce()?.shipOrders.find((x) => x === order);
    if (!o || (o.status === status && o.code === code)) return false;
    Object.assign(o, { status, code, note });
    this.mirror();
    return true;
  }

  /** What became of the build order (true when that changed it). */
  noteBuild(status: OrderStatus, code?: OrderCode, note?: string, shipId?: string): boolean {
    const b = this.inForce()?.build;
    if (!b || (b.status === status && b.code === code)) return false;
    Object.assign(b, { status, code, note, shipId: shipId ?? b.shipId });
    this.mirror();
    return true;
  }

  /** What became of a marque or patrol: saved at once while one is being sent or once sent (never sent twice). */
  noteNaval(id: string, patch: Partial<NavalOrder>): void {
    const n = this.active?.naval.find((x) => x.id === id);
    // Superseded or cleared while it was being sent: what it became still goes on its own decision.
    const d = this.decisions.find((x) => x.naval?.some((y) => y.id === id));
    const rec = d?.naval?.find((y) => y.id === id);
    const was = (n ?? rec)?.status;
    if (!n && !rec) return;
    if (n) Object.assign(n, patch);
    if (rec) Object.assign(rec, patch);
    const cur = (n ?? rec)!;
    if (d && cur.status === "issued" && was !== "issued") d.navalSpentPence = (d.navalSpentPence ?? 0) + cur.costPence;
    if (n) this.mirror();
    this.host.persist(cur.status === "issuing" || cur.status === "issued" || cur.status === "unknown");
  }

  /** What was never acted on lapses with the directives in force (shown so on their decision). */
  private lapseUnsent(): void {
    const a = this.active;
    if (!a) return;
    for (const o of [...a.shipOrders, ...(a.build ? [a.build] : [])]) if (o.status === "pending" || o.status === "waiting") o.status = "lapsed";
    for (const n of a.naval) if (n.status === "pending") n.status = "lapsed";
    // A money order waiting on a call with no answer is reconciled by the autopilot whatever comes of the advice.
    for (const o of a.finance) if (o.status === "pending" || (o.status === "waiting" && o.code !== "unknown_outcome")) o.status = "lapsed";
    this.mirror();
  }

  /** The decision record follows its orders' outcomes (the dashboard's recent advice). */
  private mirror(): void {
    const a = this.active;
    const d = a && this.decisions.find((x) => x.id === a.decisionId);
    if (!a || !d) return;
    d.shipOrders = a.shipOrders.map((o) => ({ ...o }));
    d.build = a.build ? { ...a.build } : null;
    d.naval = a.naval.map((n) => ({ ...n }));
    d.finance = a.finance.map((o) => ({ ...o }));
    this.host.persist();
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────

  /** Something worth an early look happened. */
  trigger(reason: string): void {
    if (this.mode === "off") return;
    this.pending ??= reason;
  }

  /** A free-text notice (screened by Haiku before anything uses it). */
  noteEvent(source: RawEvent["source"], text: string, at: number): void {
    if (this.mode === "off" || !text.trim()) return;
    this.raw.push({ source, text, at });
    if (this.raw.length > RAW_QUEUE_MAX) this.raw.shift();
  }

  /** A trip finished: it counts for or against the advice in force. */
  tripFinished(t: { estPerHour: number; actualPerHour: number; profitPence: number }): void {
    const a = this.inForce();
    if (a) {
      this.aiTrips.push(t.actualPerHour);
      const d = this.decisions.find((x) => x.id === a.decisionId);
      if (d) {
        d.trips++;
        d.profitPence += t.profitPence;
      }
    } else {
      this.baseTrips.push(t.actualPerHour);
    }
    if (this.aiTrips.length > TRIP_WINDOW) this.aiTrips.shift();
    if (this.baseTrips.length > TRIP_WINDOW) this.baseTrips.shift();
    if (this.mode !== "off" && t.estPerHour > 0 && t.actualPerHour < 0.4 * t.estPerHour) this.trigger("a trip made under 40% of its estimate");
    this.checkDemotion();
  }

  private checkDemotion(): void {
    if (this.effective !== "live" || this.aiTrips.length < DEMOTE_MIN_TRIPS || this.baseTrips.length < DEMOTE_MIN_TRIPS) return;
    const ai = mean(this.aiTrips)!;
    const base = mean(this.baseTrips)!;
    if (base > 0 && ai < DEMOTE_RATIO * base) {
      this.demoted = true;
      this.clear("demoted", `trips under its advice made ${cr(ai)}/h against ${cr(base)}/h without`);
      this.host.log(`AI demoted to shadow: trips under its advice made ${cr(ai)}/h against ${cr(base)}/h without; switch it to live again to retry`);
      this.aiTrips = [];
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  command(cmd: "run" | "clear" | "retry"): void {
    if (cmd === "clear") {
      this.clear("cleared", "cleared from the dashboard");
      return;
    }
    if (cmd === "retry") {
      // After a demotion: back to live with a clean record and a fresh look.
      this.demoted = false;
      this.aiTrips = [];
      this.nextRunAt = 0;
      this.lastPrint = null;
      this.skips = 0;
      this.host.persist(true);
      return;
    }
    if (this.mode === "off") throw new Error("AI support is off");
    this.pending = "asked from the dashboard";
    this.nextRunAt = 0;
  }

  /** Ends what is in force (a marque or patrol already issued runs its term: it can't be withdrawn). */
  private clear(status: AiDecision["status"], note: string): void {
    const a = this.active;
    if (!a) return;
    this.lapseUnsent();
    this.active = null;
    const d = this.decisions.find((x) => x.id === a.decisionId);
    if (d && d.status === "applied") {
      d.status = status;
      d.note = note;
    }
    this.idleSince = null;
    this.host.directivesChanged();
    this.host.persist(true);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────────

  /** Called from the manager's housekeeping (every ~10 s); starts calls in the background. */
  tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (this.spend.day !== today()) this.spend = { day: today(), today: 0, total: this.spend.total };
    const mode = this.effective;
    if (mode !== this.lastMode && mode === "off") this.lastMode = mode;
    if (this.active && now >= this.active.until) this.clear("expired", "its horizon lapsed");
    if (mode === "off") {
      if (this.active) this.clear("cleared", "AI switched off");
      this.raw = [];
      this.pending = null;
      return;
    }
    if (mode !== "live" && this.active) this.clear("cleared", "not live");

    // Tripwire: the fleet sitting idle (or held by its orders) under live directives.
    if (this.inForce() && this.host.idleShare() >= TRIPWIRE_IDLE) {
      this.idleSince ??= now;
      if (now - this.idleSince >= TRIPWIRE_MS) {
        this.host.log("AI directives cleared: half the fleet sat idle (or held by its orders) under them for 20 minutes; marques and patrols already issued run their term");
        this.clear("tripwire", "half the fleet idle or held for 20 minutes");
      }
    } else this.idleSince = null;

    if (this.raw.length && !this.screening && now - this.lastScreenAt >= SCREEN_GAP_MS) this.track(this.screen());

    this.calls = this.calls.filter((t) => now - t < 60 * 60_000);
    const due = now >= this.nextRunAt || (this.pending !== null && now - this.lastRunAt >= MIN_GAP_MS);
    if (!this.running && due && this.calls.length < MAX_PER_HOUR) this.track(this.run(this.pending ?? "routine"));
  }

  private cadence(): number {
    const w = this.host.world;
    const every = this.host.userSettings().aiIntervalMin * 60_000;
    const soon = w.tierTargetPhase !== null && (w.tierProgressBps >= 9_000 || (w.tierEtaMs !== null && w.tierEtaMs < 2 * 60 * 60_000));
    return soon ? Math.max(ROUTINE_MIN_MS, every / 2) : every;
  }

  /**
   * The parts of the picture worth a fresh answer: the phase and tier (in 10% steps), which
   * charters are stalled and which the fleet is letting lapse, where each ship is and on what
   * lane, the best lanes, spare cash (by doubling), the newest notice, the mode, the user's
   * settings it may move, and the advice in force with what became of its orders (a refusal or a
   * "done" is news). Unchanged, a routine call has nothing new to say.
   */
  private fingerprint(d: DigestInput, activeId: string | null): string {
    const u = d.user;
    const a = this.active;
    return JSON.stringify([
      this.effective,
      OVERRIDE_KEYS.map((k) => u[k]),
      a
        ? [a.shipOrders.map((o) => `${o.status}:${o.code ?? ""}`), a.build ? `${a.build.status}:${a.build.code ?? ""}` : null, a.naval.map((n) => n.status), a.finance.map((o) => `${o.status}:${o.code ?? ""}`)]
        : null,
      d.phase,
      d.tier
        ? [
            Math.floor(d.tier.progressBps / 1_000),
            d.tier.phaseSoon,
            d.tier.charters.filter((c) => c.stalled).map((c) => c.id).sort(),
            d.tier.stakes.filter((s) => s.camp).map((s) => s.id).sort(),
          ]
        : null,
      d.ships.map((s) => [s.state, s.status === "sailing" ? s.dest : s.port, s.lane?.key ?? null]),
      d.topLanes.slice(0, 5).map((l) => l.key),
      Math.floor(Math.log2(Math.max(1, d.cash.spare / 100_000))),
      d.events.at(-1)?.at ?? null,
      activeId,
    ]);
  }

  private addSpend(usd: number): void {
    if (this.spend.day !== today()) this.spend = { day: today(), today: 0, total: this.spend.total };
    this.spend.today += usd;
    this.spend.total += usd;
  }

  /**
   * Settles a reservation made on `day` by `delta` (the real cost less the reservation). After a
   * UTC midnight the old day is gone: a refund then only comes off the total, never today's spend.
   */
  private settle(delta: number, day: string): void {
    if (this.spend.day !== today()) this.spend = { day: today(), today: 0, total: this.spend.total };
    this.spend.total = Math.max(0, this.spend.total + delta);
    if (this.spend.day === day) this.spend.today = Math.max(0, this.spend.today + delta);
    else if (delta > 0) this.spend.today += delta;
  }

  /** Whether a call that may cost up to `usd` fits both caps; why not, otherwise. */
  private capRoom(usd: number): string | null {
    const s = this.host.userSettings();
    if (this.spend.today + usd > s.aiDailyCapUsd) return `today's cap ($${s.aiDailyCapUsd}) would be passed ($${this.spend.today.toFixed(2)} spent)`;
    if (this.spend.total + usd > s.aiTotalCapUsd) return `the total cap ($${s.aiTotalCapUsd}) would be passed ($${this.spend.total.toFixed(2)} spent)`;
    return null;
  }

  private async screen(): Promise<void> {
    const batch = this.raw.splice(0);
    if (!batch.length || !claudeConfigured()) return;
    this.screening = true;
    this.lastScreenAt = Date.now();
    try {
      // A Haiku batch costs a fraction of a cent; still within the caps.
      const room = this.capRoom(0.02);
      if (room) return;
      const { events, result } = await screenEvents(batch, this.host.world.catalog, this.abort.signal);
      this.addSpend(result.costUsd);
      if (this.stopped) return;
      this.events.push(...events);
      if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
      if (events.some((e) => e.severity === "high")) this.trigger("a high-severity notice");
      this.host.persist();
    } catch (e) {
      if (e instanceof ClaudeCallError) this.addSpend(e.costUsd);
      if (!this.stopped) this.host.log(`AI: screening notices failed (${describeError(e)})`);
    } finally {
      this.screening = false;
    }
  }

  // ── A strategist call ───────────────────────────────────────────────────────

  private async run(trigger: string): Promise<void> {
    this.running = true;
    this.pending = null;
    const startedAt = Date.now();
    this.nextRunAt = startedAt + this.cadence();
    // The worst case is counted (and saved) before the call goes out and settled to the real cost
    // after, so a restart, a cancel or a lost reply never lets spend slip past the caps.
    let reserved = 0;
    let reservedDay = this.spend.day;
    try {
      if (!claudeConfigured()) throw new Error("ANTHROPIC_API_KEY is not set in .env.local");
      const world = this.host.world;
      const a = this.inForce();
      const input: DigestInput = {
        ...this.host.digestInput(),
        events: [...this.events],
        decisions: this.decisions.slice(-5).map((d) => ({ at: d.at, posture: d.posture, applied: memory(d), outcome: d.mode === "live" ? `${d.trips} trips under it, ${cr(d.profitPence)} profit` : "shadow (not applied)" })),
        inForce: a ? { ...a, leftMs: Math.max(0, a.until - Date.now()) } : null,
      };
      // A quiet stretch: nothing important changed since the last answer, so a routine call is
      // skipped (a few in a row at most, so slow drifts still get a look).
      const print = this.fingerprint(input, this.active?.decisionId ?? null);
      if (trigger === "routine" && print === this.lastPrint && this.skips < MAX_SKIPS) {
        this.skips++;
        this.skippedTotal++;
        return;
      }
      this.lastRunAt = startedAt;
      this.calls.push(startedAt);
      const settings = this.host.userSettings();
      const model = settings.aiModel;
      const maxTokens = MAX_TOKENS[settings.aiEffort];
      const { text, aliases } = buildDigest(input);
      const system = systemPrompt(world.catalog);
      const worst = worstCaseUsd(model, system.length + text.length, maxTokens);
      const capped = this.capRoom(worst);
      if (capped) {
        this.lastError = `skipped: ${capped}`;
        return;
      }
      const builtAt = Date.now();
      const phase = world.unlockedPhase;
      this.addSpend(worst);
      reserved = worst;
      reservedDay = this.spend.day;
      this.host.persist(true);
      const res = await callStructured({
        model,
        system,
        // Cached only when the next call should come within the hour the cache lives.
        cacheSystem: this.cadence() <= CACHE_WHEN_UNDER_MS,
        user: text,
        schema: ADVICE_SCHEMA,
        effort: settings.aiEffort,
        maxTokens,
        signal: this.abort.signal,
      });
      this.settle(res.costUsd - reserved, reservedDay);
      reserved = 0;
      this.skips = 0;
      if (this.stopped) return;
      const d = this.apply(res.json as RawAdvice, aliases, { trigger, builtAt, phase, model: res.model, costUsd: res.costUsd });
      // The picture as this answer left it (its own advice now in force); a discarded answer
      // doesn't count as having seen it.
      this.lastPrint = d.status === "discarded" ? null : this.fingerprint(input, this.active?.decisionId ?? null);
      this.lastError = null;
      void this.record(d, res.usage, text.length);
    } catch (e) {
      // Settle the reservation: the known cost of a failed reply, nothing for a call that can't
      // have been billed, the worst case kept for one whose cost is unknown (timeout, cancel).
      if (e instanceof ClaudeCallError) this.settle(e.costUsd - reserved, reservedDay);
      else if (notBilled(e)) this.settle(-reserved, reservedDay);
      if (this.stopped) return;
      this.lastError = describeError(e);
      this.host.log(`AI: the strategist call failed (${this.lastError})`);
    } finally {
      this.running = false;
      if (!this.stopped) this.host.persist(true);
    }
  }

  /** Validates, clamps and resolves an answer (directives.ts), then applies it (live) or records it (shadow). */
  private apply(raw: RawAdvice, aliases: Aliases, meta: { trigger: string; builtAt: number; phase: number; model: string; costUsd: number }): AiDecision {
    const world = this.host.world;
    const user = this.host.userSettings();
    const { d: x, horizonMin, items, dropped } = validateAnswer(raw, aliases, this.host.limits());
    const id = randomUUID();
    // Unique across answers: a superseded answer's marque still being sent is never taken for this one's.
    for (const n of x.naval) n.id = `${id.slice(0, 8)}:${n.id}`;
    for (const o of x.finance) o.id = `${id.slice(0, 8)}:${o.id}`;
    // Forbidden classes come off the user's list like any setting (and lapse with it once the user edits the list).
    const kept = user.buyClasses.filter((c) => !x.forbid.includes(c));
    if (kept.length < user.buyClasses.length) {
      x.settings.buyClasses = kept;
      x.settingReasons.buyClasses ??= String(raw.buy?.reason ?? "").slice(0, 200);
    }
    const settings = x.settings;
    const live = this.effective === "live";
    const d: AiDecision = {
      id,
      at: new Date().toISOString(),
      trigger: meta.trigger,
      mode: live ? "live" : "shadow",
      model: meta.model,
      costUsd: Math.round(meta.costUsd * 10_000) / 10_000,
      posture: String(raw.posture ?? "balanced"),
      horizonMin,
      rationale: String(raw.rationale ?? "").slice(0, 1_500),
      settings: { ...settings },
      biases: x.biases.map((b) => ({ label: b.label, factor: Math.round(b.factor * 100) / 100, reason: b.reason })),
      stallCalls: x.stallCalls.map((s) => ({ label: s.label, call: s.call, reason: s.reason })),
      buy: { action: x.buyHold ? "hold" : x.build ? "build" : "auto", reason: String(raw.buy?.reason ?? "").slice(0, 200) },
      alerts: (raw.alerts ?? []).slice(0, 5).map((a) => String(a).slice(0, 300)),
      dropped,
      status: live ? "applied" : "shadow",
      trips: 0,
      profitPence: 0,
      settingReasons: { ...x.settingReasons },
      avoid: x.avoid.map((b) => ({ kind: b.kind, label: b.label, reason: b.reason })),
      shipOrders: x.shipOrders.map((o) => ({ ...o })),
      build: x.build ? { ...x.build } : null,
      forbid: [...x.forbid],
      naval: x.naval.map((n) => ({ ...n })),
      finance: x.finance.map((o) => ({ ...o })),
    };
    // Recorded first: orders carried out as it is applied (a release) show on it at once.
    this.decisions.push(d);
    if (this.decisions.length > DECISIONS_KEPT) this.decisions.splice(0, this.decisions.length - DECISIONS_KEPT);

    // Discard: too many invalid items, a stale digest, or a phase that changed while it thought.
    const why =
      items >= 3 && dropped / items > MAX_INVALID
        ? `${dropped} of ${items} items referred to nothing in the digest`
        : Date.now() - meta.builtAt > STALE_MS
          ? "the answer came back after its digest was stale"
          : world.unlockedPhase !== meta.phase
            ? "a phase opened while it was thinking"
            : null;
    const any =
      Object.keys(settings).length > 0 ||
      x.biases.length > 0 ||
      x.stallCalls.length > 0 ||
      x.buyHold !== null ||
      x.avoid.length > 0 ||
      x.shipOrders.length > 0 ||
      x.build !== null ||
      x.naval.length > 0 ||
      x.finance.length > 0;
    if (why) {
      d.status = "discarded";
      d.note = why;
    } else if (live && !any) {
      // Advice to change nothing: whatever was in force ends, and trips count as without advice.
      d.status = "shadow";
      d.note = "no changes";
      if (this.active) this.clear("superseded", "a later answer changed nothing");
    } else if (live) {
      // Superseded: the old answer's unsent marques, patrols and build go with it (one being sent is still recorded).
      const prev = this.active;
      if (prev) {
        this.lapseUnsent();
        const p = this.decisions.find((y) => y.id === prev.decisionId);
        if (p && p.status === "applied") p.status = "superseded";
      }
      const base: OverrideSettings = {};
      for (const k of Object.keys(settings) as OverrideKey[]) (base as Record<string, unknown>)[k] = user[k];
      this.active = { ...x, decisionId: d.id, until: Date.now() + horizonMin * 60_000, settings: { ...settings }, base };
      // The tripwire's idle clock runs on across answers (tick resets it once the fleet is busy again): frequent
      // answers mustn't keep it from ever firing.
      this.host.directivesChanged();
    }

    const changes = [
      Object.keys(settings).length ? `settings ${JSON.stringify(settings)}` : "",
      x.avoid.length ? `avoid ${x.avoid.map((b) => b.label).join(", ")}` : "",
      x.biases.length ? plural(x.biases.length, "lane bias", "lane biases") : "",
      x.stallCalls.length ? plural(x.stallCalls.length, "stall call") : "",
      x.shipOrders.length ? plural(x.shipOrders.length, "ship order") : "",
      x.buyHold ? "buyer on hold" : x.build ? `build a ${x.build.cls} at ${x.build.yard}` : "",
      x.naval.length ? x.naval.map((n) => `${n.kind} ${n.bps} bps in ${n.zone} for ${n.gameHours} game h (${n.costPence > 0 ? `~${cr(n.costPence)}` : "priced by its quote when issued"})`).join(", ") : "",
      x.finance.length ? x.finance.map((o) => o.label).join(", ") : "",
    ].filter(Boolean);
    this.host.log(
      `AI (${d.mode}, ${meta.trigger}, $${d.costUsd.toFixed(3)}): ${d.posture}; ${changes.join(", ") || "no changes"}` +
        `${d.status === "discarded" ? ` - discarded: ${d.note}` : d.mode === "live" ? ` for ${horizonMin} min` : ""}`,
    );
    for (const a of d.alerts) this.host.log(`AI note: ${a}`);
    return d;
  }

  /** Keeps every decision in the database too (best effort). */
  private async record(d: AiDecision, usage: object, digestChars: number): Promise<void> {
    try {
      const db = mongoDb();
      if (!db) return;
      await (await db).collection("ai_decisions").insertOne({ companyId: this.host.companyId(), ...d, usage, digestChars, savedAt: new Date() });
    } catch {
      // The snapshot keeps the recent ones; the history is a bonus.
    }
  }

  // ── Dashboard and persistence ───────────────────────────────────────────────

  report(): AiReport {
    const s = this.host.userSettings();
    const a = this.inForce();
    return {
      mode: s.ai,
      effective: this.effective,
      demoted: this.demoted,
      configured: claudeConfigured(),
      running: this.running,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      nextRunAt: this.effective !== "off" && this.nextRunAt ? new Date(Math.max(this.nextRunAt, Date.now())).toISOString() : null,
      lastError: this.lastError,
      spend: { ...this.spend, dailyCap: s.aiDailyCapUsd, totalCap: s.aiTotalCapUsd },
      model: AI_MODEL_NAMES[s.aiModel] ?? s.aiModel,
      effort: s.aiEffort,
      intervalMin: s.aiIntervalMin,
      avgCostUsd: mean(this.decisions.map((d) => d.costUsd)),
      skipped: this.skippedTotal,
      active: a
        ? {
            decisionId: a.decisionId,
            until: new Date(a.until).toISOString(),
            settings: Object.entries(this.overrides() ?? {}).map(([key, to]) => ({ key, from: s[key as OverrideKey], to, reason: a.settingReasons[key as OverrideKey] ?? "" })),
            avoid: a.avoid.map((b) => ({ kind: b.kind, label: b.label, reason: b.reason })),
            biases: a.biases.map((b) => ({ label: b.label, factor: b.factor, reason: b.reason })),
            stallCalls: a.stallCalls.map((x) => ({ label: x.label, call: x.call, reason: x.reason })),
            shipOrders: a.shipOrders.map((o) => ({ shipId: o.ship, order: o.order, label: o.label, status: o.status, code: o.code, note: o.note, reason: o.reason })),
            buy: { hold: a.buyHold, build: a.build ? { ...a.build } : null, forbid: [...a.forbid] },
            naval: a.naval.map((n) => ({ ...n })),
            finance: a.finance.map((o) => ({ ...o })),
          }
        : null,
      decisions: [...this.decisions].reverse().slice(0, 10),
      events: [...this.events].reverse().slice(0, 10),
      uplift: { aiTrips: this.aiTrips.length, aiPerHour: mean(this.aiTrips), baseTrips: this.baseTrips.length, basePerHour: mean(this.baseTrips) },
    };
  }

  snapshot(): AdvisorSnapshot {
    return {
      spend: { ...this.spend },
      decisions: this.decisions,
      active: this.active,
      demoted: this.demoted,
      aiTrips: this.aiTrips,
      baseTrips: this.baseTrips,
      events: this.events,
      lastRunAt: this.lastRunAt,
    };
  }

  restore(s: AdvisorSnapshot | undefined): void {
    if (!s) return;
    this.spend = s.spend.day === today() ? { ...s.spend } : { day: today(), today: 0, total: s.spend.total ?? 0 };
    this.decisions = (s.decisions ?? []).slice(-DECISIONS_KEPT);
    // Older saves lack the later directives; a marque or patrol cut off mid-call is unknown (never sent again).
    this.active = s.active && s.active.until > Date.now() ? normalizeActive(s.active) : null;
    // One that lapsed while the autopilot was stopped is marked so.
    if (s.active && !this.active) {
      const d = this.decisions.find((x) => x.id === s.active!.decisionId);
      if (d && d.status === "applied") {
        d.status = "expired";
        d.note = "its horizon lapsed while the autopilot was stopped";
      }
    }
    // A demotion only stands while the user still has it on live.
    this.demoted = !!s.demoted && this.mode === "live";
    this.aiTrips = (s.aiTrips ?? []).slice(-TRIP_WINDOW);
    this.baseTrips = (s.baseTrips ?? []).slice(-TRIP_WINDOW);
    this.events = (s.events ?? []).slice(-EVENTS_KEPT);
    this.lastRunAt = s.lastRunAt ?? 0;
    // After a restart the next routine call is due a cadence after the last one.
    this.nextRunAt = this.lastRunAt ? this.lastRunAt + this.host.userSettings().aiIntervalMin * 60_000 : 0;
    this.lastMode = this.mode;
  }
}
