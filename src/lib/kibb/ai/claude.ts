/**
 * Claude API access for the AI advisor: one client (ANTHROPIC_API_KEY), what each model costs, and
 * a structured-output call (JSON matching a schema) that reports its exact cost. Server-only.
 */

import Anthropic from "@anthropic-ai/sdk";

/** The strategist (default model) and the free-text screen. */
export const STRATEGIST_MODEL = "claude-opus-5-5";
export const SCREEN_MODEL = "claude-haiku-5-5";

/** Dollars per million tokens: input, output, cache read. A one-hour cache write costs 2x input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
/** Unknown models (a fallback we didn't list) are priced like the dearest listed. */
const PRICE_FALLBACK = { input: 5, output: 25, cacheRead: 0.5 };
const CACHE_WRITE_1H = 2;

const g = globalThis as { __kibbClaude?: Anthropic };

export function claudeConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function client(): Anthropic {
  // Reads ANTHROPIC_API_KEY. Retries are decided per call (see callStructured).
  return (g.__kibbClaude ??= new Anthropic({ timeout: 10 * 60_000, maxRetries: 0 }));
}

export interface CallUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Dollars a call cost, from its usage and the model that served it. */
export function costUsd(model: string, u: CallUsage): number {
  const p = PRICES[model] ?? PRICE_FALLBACK;
  return (u.input * p.input + u.cacheWrite * p.input * CACHE_WRITE_1H + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
}

/**
 * The most a call can cost: every prompt token written to the cache and every output token used,
 * and for Opus (server-side fallbacks) a second full attempt on the fallback model.
 */
export function worstCaseUsd(model: string, promptChars: number, maxTokens: number): number {
  // ~3 characters a token for this mixed text and JSON: errs high.
  const one = (p: { input: number; output: number }) => ((promptChars / 3) * p.input * CACHE_WRITE_1H + maxTokens * p.output) / 1e6;
  const p = PRICES[model] ?? PRICE_FALLBACK;
  return one(p) + (model.startsWith("claude-opus") ? one(PRICE_FALLBACK) : 0);
}

export class ClaudeCallError extends Error {
  constructor(
    message: string,
    /** What the failed call still cost (refusals and truncated replies are billed). */
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = "ClaudeCallError";
  }
}

export interface StructuredCall {
  model: string;
  /** Cancels the call (the autopilot is stopping). */
  signal?: AbortSignal;
  /** Stable text: cached for an hour when `cacheSystem` is set. */
  system: string;
  cacheSystem: boolean;
  user: string;
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  maxTokens: number;
}

export interface StructuredResult {
  json: unknown;
  /** The model that answered (a fallback model if the requested one declined). */
  model: string;
  usage: CallUsage;
  costUsd: number;
}

/**
 * One request whose answer is JSON matching `schema` (structured outputs). Opus calls go through
 * the beta endpoint with server-side fallbacks ("default"), so a safety decline is retried on the
 * model Anthropic recommends instead of failing. Throws ClaudeCallError on a refusal, a truncated
 * reply or unparseable JSON, carrying what the call cost.
 */
export async function callStructured(c: StructuredCall): Promise<StructuredResult> {
  const system = [
    c.cacheSystem
      ? { type: "text" as const, text: c.system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
      : { type: "text" as const, text: c.system },
  ];
  const opus = c.model.startsWith("claude-opus");
  // Streamed, so a long answer isn't cut off by an HTTP timeout; never retried behind our back
  // (an abandoned attempt may still be billed), except for the cheap screen.
  const res = await client()
    .beta.messages.stream(
      {
        model: c.model,
        max_tokens: c.maxTokens,
        ...(opus ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: c.effort, format: { type: "json_schema", schema: c.schema } },
        system,
        messages: [{ role: "user", content: c.user }],
      },
      { signal: c.signal, maxRetries: opus ? 0 : 2 },
    )
    .finalMessage();
  const usage: CallUsage = {
    input: res.usage.input_tokens ?? 0,
    cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    cacheRead: res.usage.cache_read_input_tokens ?? 0,
    output: res.usage.output_tokens ?? 0,
  };
  const model = res.model ?? c.model;
  // With fallbacks, each attempt (a declined one too) is billed: priced per attempt when listed.
  const its = (res.usage as { iterations?: Array<Record<string, unknown>> | null }).iterations;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const cost = its?.length
    ? its.reduce(
        (sum, i) =>
          sum +
          costUsd(typeof i.model === "string" ? i.model : model, {
            input: n(i.input_tokens),
            cacheWrite: n(i.cache_creation_input_tokens),
            cacheRead: n(i.cache_read_input_tokens),
            output: n(i.output_tokens),
          }),
        0,
      )
    : costUsd(model, usage);
  if (res.stop_reason === "refusal") throw new ClaudeCallError(`${model} declined the request`, cost);
  if (res.stop_reason === "max_tokens") throw new ClaudeCallError(`${model} ran out of room before finishing`, cost);
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { json: JSON.parse(text), model, usage, costUsd: cost };
  } catch {
    throw new ClaudeCallError(`${model} returned text that isn't the requested JSON`, cost);
  }
}

/**
 * Whether a failed call can't have been billed (refused before any model ran): its reserved spend
 * can be released. Anything else (timeouts, dropped connections, cancels) may have been billed.
 */
export function notBilled(e: unknown): boolean {
  // An HTTP error status arrives before the stream starts, so nothing was generated. Errors in the
  // middle of a stream, dropped connections and cancels carry no status: those may be billed.
  return (e instanceof Anthropic.APIError && typeof e.status === "number") || (e instanceof Error && e.message.includes("ANTHROPIC_API_KEY"));
}

/** A short, safe description of a failed call for the log (no request contents). */
export function describeError(e: unknown): string {
  if (e instanceof ClaudeCallError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "the ANTHROPIC_API_KEY was rejected";
  if (e instanceof Anthropic.PermissionDeniedError) return "the API key isn't allowed to use this model";
  if (e instanceof Anthropic.RateLimitError) return "rate limited by the Claude API";
  if (e instanceof Anthropic.BadRequestError) return `the Claude API refused the request: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}: ${e.message}`.trim();
  return (e as Error)?.message ?? String(e);
}
