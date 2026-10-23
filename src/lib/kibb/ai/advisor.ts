/**
 * The AI advisor: Claude as the fleet's strategist. Every 30 minutes (15 near a phase turnover), and
 * soon after a phase change, a stall escalation, a lost ship or a trip far below its estimate, it
 * reads a digest of the fleet and the world (digest.ts) and answers with directives: temporary
 * setting overrides within limits, a bias on lane ranks, per-charter stall calls, and buy hold.
 *
 * Off by default. In "shadow" mode it advises and logs but changes nothing; in "live" the directives
 * apply until their horizon lapses. Every check in the autopilot still runs: overrides are clamped,
 * a bias only reorders lanes that already pass, a stall call only works on a posting that is
 * stalled, and the buyer can only be told to hold.
 *
 * Safeguards: spend caps per UTC day and in total (a call is skipped if its worst case could pass
 * one), a tripwire that clears the directives if half the fleet sits idle for 20 minutes under them,
 * and auto-demotion to shadow when trips made under its advice earn clearly less than without.
 * Free text never reaches the strategist: notices go through the Haiku screen (screen.ts) first.
 */

import { randomUUID } from "node:crypto";
import type { FleetSettings } from "../fleet/manager";
import type { Lane } from "../fleet/planner";
import type { World } from "../fleet/world";
import { mongoDb } from "../mongo";
import { AI_MODEL_NAMES, callStructured, ClaudeCallError, claudeConfigured, describeError, notBilled, worstCaseUsd, type AiEffort } from "./claude";
import {
  ADVICE_SCHEMA,
  BIAS_MAX,
  BIAS_MIN,
  buildDigest,
  ENVELOPE,
  HORIZON_MAX,
  HORIZON_MIN,
  MAX_BIASES,
  MAX_STALL_CALLS,
  systemPrompt,
  type Aliases,
  type DigestInput,
  type RawAdvice,
} from "./digest";
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
/** Room for the answer (thinking included) by effort: thinking is most of a call's cost. */
const MAX_TOKENS: Record<AiEffort, number> = { low: 6_000, medium: 10_000, high: 16_000 };
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

type OverrideKey = "bonusWeightPct" | "phaseChestPct" | "minMarginPence" | "holdForRepost";
type OverrideSettings = Partial<Pick<FleetSettings, OverrideKey>>;
const OVERRIDE_KEYS: OverrideKey[] = ["bonusWeightPct", "phaseChestPct", "minMarginPence", "holdForRepost"];

interface Bias {
  match: "dest" | "source" | "good" | "charter" | "lane";
  /** Port or good id, charter id, or lane key. */
  ref: string;
  factor: number;
  label: string;
  reason: string;
}

interface StallCall {
  /** `port|good` of the expansion charter. */
  key: string;
  call: "wait" | "deliver";
  label: string;
  reason: string;
}

/** The directives in force (live mode only). */
interface Active {
  decisionId: string;
  /** Local ms when they lapse. */
  until: number;
  settings: OverrideSettings;
  /** The user's value each override was clamped against: an override lapses once the user changes it. */
  base?: OverrideSettings;
  biases: Bias[];
  stallCalls: StallCall[];
  buyHold: string | null;
}

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
  buy: { action: "auto" | "hold"; reason: string };
  alerts: string[];
  /** Items of the answer dropped as invalid (unknown alias or id, out of scope). */
  dropped: number;
  status: "applied" | "shadow" | "discarded" | "expired" | "cleared" | "tripwire" | "superseded" | "demoted";
  note?: string;
  /** Trips finished while it was in force (live), and their profit. */
  trips: number;
  profitPence: number;
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
  active: {
    decisionId: string;
    until: string;
    settings: OverrideSettings;
    biases: Array<{ label: string; factor: number }>;
    stallCalls: Array<{ label: string; call: "wait" | "deliver" }>;
    buyHold: string | null;
  } | null;
  decisions: AiDecision[];
  events: ScreenedEvent[];
  uplift: { aiTrips: number; aiPerHour: number | null; baseTrips: number; basePerHour: number | null };
}

export interface AdvisorSnapshot {
  spend: { day: string; today: number; total: number };
  decisions: AiDecision[];
  active: Active | null;
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
  /** The digest's inputs from the fleet's current state (events and decisions are filled in here). */
  digestInput(): Omit<DigestInput, "events" | "decisions">;
  /** Share of the fleet idle for want of a lane. */
  idleShare(): number;
  log(msg: string): void;
  persist(now?: boolean): void;
  /** The overrides, biases or stall calls in force changed: ships may re-plan. */
  directivesChanged(): void;
  companyId(): string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
const cr = (p: number) => `${Math.round(p / 100).toLocaleString("en-GB")} Cr`;

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
    // The user changed a setting the AI had overridden: theirs wins for the rest of this advice.
    const a = this.active;
    const gone = a ? OVERRIDE_KEYS.filter((k) => k in a.settings && prev[k] !== next[k]) : [];
    if (a && gone.length) {
      const settings = { ...a.settings };
      const base = { ...a.base };
      for (const k of gone) {
        delete settings[k];
        delete base[k];
      }
      a.settings = settings;
      a.base = base;
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

  /** Setting overrides in force (clamped when applied), or null. One the user has since changed no longer applies. */
  overrides(): OverrideSettings | null {
    const a = this.inForce();
    if (!a) return null;
    const user = this.host.userSettings();
    const out: OverrideSettings = {};
    for (const k of OVERRIDE_KEYS) {
      if (!(k in a.settings) || !a.base || a.base[k] !== user[k]) continue;
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
    let f = 1;
    for (const b of a.biases) {
      const hit =
        b.match === "dest"
          ? lane.dest === b.ref
          : b.match === "source"
            ? lane.source === b.ref
            : b.match === "good"
              ? lane.good === b.ref || lane.parts.some((p) => p.good === b.ref)
              : b.match === "charter"
                ? // Both sides followed to the posting that now stands for them (it may have re-posted).
                  lane.fills.some(([id]) => this.host.world.currentId(id) === this.host.world.currentId(b.ref))
                : lane.key === b.ref;
      if (hit) f *= b.factor;
    }
    return Math.min(BIAS_MAX, Math.max(BIAS_MIN, f));
  }

  /** Stall calls in force, by `port|good`. */
  stallCalls(): Map<string, "wait" | "deliver"> | undefined {
    const a = this.inForce();
    return a && a.stallCalls.length ? new Map(a.stallCalls.map((s) => [s.key, s.call])) : undefined;
  }

  stallCall(port: string, good: string): "wait" | "deliver" | undefined {
    return this.inForce()?.stallCalls.find((s) => s.key === `${port}|${good}`)?.call;
  }

  /** Why the buyer should hold, or null. */
  buyHold(): string | null {
    return this.inForce()?.buyHold ?? null;
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

  private clear(status: AiDecision["status"], note: string): void {
    const a = this.active;
    if (!a) return;
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

    // Tripwire: the fleet sitting idle under live directives.
    if (this.inForce() && this.host.idleShare() >= TRIPWIRE_IDLE) {
      this.idleSince ??= now;
      if (now - this.idleSince >= TRIPWIRE_MS) {
        this.host.log("AI directives cleared: half the fleet sat idle under them for 20 minutes");
        this.clear("tripwire", "half the fleet idle for 20 minutes");
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
   * charters are stalled, where each ship is and on what lane, the best lanes, spare cash (by
   * doubling), the newest notice, the mode, the user's settings it may move, and the advice in
   * force. Unchanged, a routine call has nothing new to say.
   */
  private fingerprint(d: DigestInput, activeId: string | null): string {
    const u = d.user;
    return JSON.stringify([
      this.effective,
      [u.bonusWeightPct, u.phaseChestPct, u.minMarginPence, u.holdForRepost],
      d.phase,
      d.tier ? [Math.floor(d.tier.progressBps / 1_000), d.tier.phaseSoon, d.tier.charters.filter((c) => c.stalled).map((c) => c.id).sort()] : null,
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
      const input: DigestInput = {
        ...this.host.digestInput(),
        events: [...this.events],
        decisions: this.decisions.slice(-5).map((d) => ({
          at: d.at,
          posture: d.posture,
          applied: `${d.status}${Object.keys(d.settings).length ? `, settings ${JSON.stringify(d.settings)}` : ""}${d.biases.length ? `, ${d.biases.length} biases` : ""}${d.buy.action === "hold" ? ", buy held" : ""}`,
          outcome: d.mode === "live" ? `${d.trips} trips under it, ${cr(d.profitPence)} profit` : "shadow (not applied)",
        })),
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

  /** Validates, clamps and resolves an answer, then applies it (live) or records it (shadow). */
  private apply(raw: RawAdvice, aliases: Aliases, meta: { trigger: string; builtAt: number; phase: number; model: string; costUsd: number }): AiDecision {
    const world = this.host.world;
    const user = this.host.userSettings();
    let dropped = 0;
    let items = 0;

    // Settings: within the envelope and one step from the user's value; only real changes kept.
    const settings: OverrideSettings = {};
    const s = raw.settings ?? ({} as RawAdvice["settings"]);
    // Within the envelope and one step of the user's value, in the direction asked; nothing if the
    // user's own value is already outside the envelope or the answer repeats it.
    const step = (v: number | null, base: number, e: { min: number; max: number; step: number }) => {
      if (v === null || !Number.isFinite(v) || v === base || base < e.min || base > e.max) return null;
      const lo = Math.max(e.min, base - e.step);
      const hi = Math.min(e.max, base + e.step);
      const r = Math.round(Math.min(hi, Math.max(lo, v)));
      // Never past what was asked, and never the other way.
      return (r - base) * (v - base) > 0 && (r - base) * (r - v) <= 0 ? r : null;
    };
    const bw = step(s.bonusWeightPct ?? null, user.bonusWeightPct, ENVELOPE.bonusWeightPct);
    if (bw !== null && bw !== user.bonusWeightPct) settings.bonusWeightPct = bw;
    const pc = step(s.phaseChestPct ?? null, user.phaseChestPct, ENVELOPE.phaseChestPct);
    if (pc !== null && pc !== user.phaseChestPct) settings.phaseChestPct = pc;
    if (s.minMarginPence !== null && Number.isFinite(s.minMarginPence)) {
      const lo = Math.round(user.minMarginPence * ENVELOPE.minMarginFactor.min);
      const hi = Math.round(user.minMarginPence * ENVELOPE.minMarginFactor.max);
      const v = Math.round(Math.min(hi, Math.max(lo, s.minMarginPence!)));
      if (v !== user.minMarginPence) settings.minMarginPence = v;
    }
    if (typeof s.holdForRepost === "boolean" && s.holdForRepost !== user.holdForRepost) settings.holdForRepost = s.holdForRepost;

    // Lane biases: resolve aliases and ids, drop what isn't real.
    const biases: Bias[] = [];
    for (const b of (raw.laneBias ?? []).slice(0, MAX_BIASES)) {
      items++;
      const factor = Math.min(BIAS_MAX, Math.max(BIAS_MIN, Number(b.factor)));
      if (!Number.isFinite(factor)) {
        dropped++;
        continue;
      }
      let ref: string | undefined;
      let label = "";
      if (b.match === "dest" || b.match === "source") {
        if (world.port(b.ref) && world.isOpen(b.ref)) ref = b.ref;
        label = `${b.match === "dest" ? "to" : "from"} ${b.ref}`;
      } else if (b.match === "good") {
        if (world.catalog.commodities.some((c) => c.id === b.ref)) ref = b.ref;
        label = `${b.ref}`;
      } else if (b.match === "charter") {
        const c = aliases.charters.get(b.ref);
        if (c) {
          ref = c.id;
          label = `${c.good} -> ${c.port} charter`;
        }
      } else if (b.match === "lane") {
        ref = aliases.lanes.get(b.ref);
        label = ref ? `lane ${ref}` : "";
      }
      if (!ref) {
        dropped++;
        continue;
      }
      biases.push({ match: b.match, ref, factor, label, reason: String(b.reason ?? "").slice(0, 200) });
    }

    // Stall calls: expansion charters only.
    const stallCalls: StallCall[] = [];
    for (const sc of (raw.stallCalls ?? []).slice(0, MAX_STALL_CALLS)) {
      items++;
      const c = aliases.charters.get(sc.charter);
      if (!c || !world.renews(c) || (sc.call !== "wait" && sc.call !== "deliver")) {
        dropped++;
        continue;
      }
      stallCalls.push({ key: `${c.port}|${c.good}`, call: sc.call, label: `${c.good} -> ${c.port}`, reason: String(sc.reason ?? "").slice(0, 200) });
    }
    items += Object.keys(settings).length;

    const horizonMin = Math.round(Math.min(HORIZON_MAX, Math.max(HORIZON_MIN, Number(raw.horizonMin) || 60)));
    const buy = { action: raw.buy?.action === "hold" ? ("hold" as const) : ("auto" as const), reason: String(raw.buy?.reason ?? "").slice(0, 200) };
    const live = this.effective === "live";
    const d: AiDecision = {
      id: randomUUID(),
      at: new Date().toISOString(),
      trigger: meta.trigger,
      mode: live ? "live" : "shadow",
      model: meta.model,
      costUsd: Math.round(meta.costUsd * 10_000) / 10_000,
      posture: String(raw.posture ?? "balanced"),
      horizonMin,
      rationale: String(raw.rationale ?? "").slice(0, 1_500),
      settings,
      biases: biases.map((b) => ({ label: b.label, factor: Math.round(b.factor * 100) / 100, reason: b.reason })),
      stallCalls: stallCalls.map((x) => ({ label: x.label, call: x.call, reason: x.reason })),
      buy,
      alerts: (raw.alerts ?? []).slice(0, 5).map((a) => String(a).slice(0, 300)),
      dropped,
      status: live ? "applied" : "shadow",
      trips: 0,
      profitPence: 0,
    };

    // Discard: too many invalid items, a stale digest, or a phase that changed while it thought.
    const why =
      items >= 3 && dropped / items > MAX_INVALID
        ? `${dropped} of ${items} items referred to nothing in the digest`
        : Date.now() - meta.builtAt > STALE_MS
          ? "the answer came back after its digest was stale"
          : world.unlockedPhase !== meta.phase
            ? "a phase opened while it was thinking"
            : null;
    const any = Object.keys(settings).length > 0 || biases.length > 0 || stallCalls.length > 0 || buy.action === "hold";
    if (why) {
      d.status = "discarded";
      d.note = why;
    } else if (live && !any) {
      // Advice to change nothing: whatever was in force ends, and trips count as without advice.
      d.status = "shadow";
      d.note = "no changes";
      if (this.active) this.clear("superseded", "a later answer changed nothing");
    } else if (live) {
      const prev = this.active;
      if (prev) {
        const p = this.decisions.find((x) => x.id === prev.decisionId);
        if (p && p.status === "applied") p.status = "superseded";
      }
      const base: OverrideSettings = {};
      for (const k of Object.keys(settings) as OverrideKey[]) (base as Record<string, unknown>)[k] = user[k];
      this.active = {
        decisionId: d.id,
        until: Date.now() + horizonMin * 60_000,
        settings: { ...settings },
        base,
        biases,
        stallCalls,
        buyHold: buy.action === "hold" ? buy.reason || "held by the AI" : null,
      };
      this.idleSince = null;
      this.host.directivesChanged();
    }
    this.decisions.push(d);
    if (this.decisions.length > DECISIONS_KEPT) this.decisions.splice(0, this.decisions.length - DECISIONS_KEPT);

    const changes = [
      Object.keys(settings).length ? `settings ${JSON.stringify(settings)}` : "",
      biases.length ? `${biases.length} lane bias${biases.length === 1 ? "" : "es"}` : "",
      stallCalls.length ? `${stallCalls.length} stall call${stallCalls.length === 1 ? "" : "s"}` : "",
      buy.action === "hold" ? "buyer on hold" : "",
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
            settings: this.overrides() ?? {},
            biases: a.biases.map((b) => ({ label: b.label, factor: b.factor })),
            stallCalls: a.stallCalls.map((x) => ({ label: x.label, call: x.call })),
            buyHold: a.buyHold,
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
    this.active = s.active && s.active.until > Date.now() ? s.active : null;
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
