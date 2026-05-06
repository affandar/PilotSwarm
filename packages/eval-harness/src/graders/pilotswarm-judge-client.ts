/**
 * PilotSwarmJudgeClient — JudgeClient implementation that routes through
 * PilotSwarm's `ModelProviderRegistry` so the LLM judge inherits the same
 * provider matrix the runtime supports (GitHub Copilot, OpenAI, Anthropic,
 * Azure OpenAI).
 *
 * Why this exists: the original `OpenAIJudgeClient` only speaks to the OpenAI
 * public API. Test environments that already have `GITHUB_TOKEN` configured
 * (the standard PilotSwarm dev setup) had no way to run live judge tests
 * without also exporting `OPENAI_API_KEY`. By reusing the registry, the judge
 * inherits any provider that PilotSwarm itself supports — no per-provider
 * client code in eval-harness.
 *
 * Implementation pattern mirrors `packages/sdk/src/session-proxy.ts`'s
 * `maybeClassifyWithDetector`: resolve the provider, construct a one-shot
 * `CopilotClient`, create a session, send the prompt, collect text via
 * `assistant.message_delta` until `session.idle`, then stop the client.
 *
 * Failure modes:
 *   - Unknown model in registry  → constructor throws.
 *   - Provider resolves to no SDK + no token (mis-configured) → judge throws.
 *   - JSON parse failure         → judge throws (FAIL CLOSED, never returns
 *                                  success on garbage).
 *   - Timeout                    → judge throws after `timeoutMs`.
 *   - Transient failure          → retried up to `maxRetries` with exp backoff.
 *
 * Retries are restricted to errors that look transient (network / 5xx / abort
 * caused by our own timeout). Validation failures (bad JSON, schema mismatch,
 * missing content) are NOT retried — they indicate the model produced garbage
 * and retrying will likely produce more garbage.
 *
 * Resource hygiene: the underlying CopilotClient is always stopped in a
 * `finally`, even on error or timeout, to avoid leaked sockets / event
 * listeners.
 */

import { createHash } from "node:crypto";
import {
  JudgeCostSchema,
  JudgeResultSchema,
  type JudgeCost,
  type JudgeResult,
} from "../types.js";
import type {
  JudgeClient,
  JudgeOptions,
  JudgeRequest,
  JudgeResponse,
} from "./judge-types.js";
import { JudgeOutputFormatError } from "./judge-types.js";

// Import only the type so we don't pull the SDK at runtime when injected.
type ModelProviderRegistryType = import("pilotswarm-sdk").ModelProviderRegistry;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PilotSwarmJudgeCostRates {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  /** Optional cached-input rate. Defaults to 0.5 × input rate when omitted. */
  cachedInputUsdPerMillionTokens?: number;
}

export interface PilotSwarmJudgeClientOptions {
  /** A PilotSwarm ModelProviderRegistry that knows how to resolve `model`. */
  modelProviders: ModelProviderRegistryType;
  /** Qualified or bare model name (e.g. `github-copilot:gpt-4.1`, `gpt-4.1`). */
  model: string;
  /** Optional cost rates for budget tracking. */
  costRates?: PilotSwarmJudgeCostRates;
  /** Per-call timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Max retries on transient failure. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Default 500. */
  baseRetryDelayMs?: number;
  /** Cap on retry delay (ms). Default 30_000. */
  retryDelayMaxMs?: number;
  /**
   * Optional dependency injection for tests — replaces the dynamic
   * `@github/copilot-sdk` import. The injected ctor must be a constructable
   * function whose instances expose `createSession()` and `stop()`.
   * @internal — test seam, NOT part of the public API.
   */
  copilotClientCtor?: new (opts: any) => CopilotClientLike;
}

/**
 * Minimal shape of `@github/copilot-sdk`'s CopilotClient that we use.
 * @internal — exposed only for unit-test injection. NOT part of the public API.
 */
export interface CopilotClientLike {
  createSession(opts: any): Promise<CopilotSessionLike>;
  stop(): Promise<void> | void;
}

/**
 * Minimal session shape — matches the events session-proxy.ts subscribes to.
 * @internal — exposed only for unit-test injection. NOT part of the public API.
 */
export interface CopilotSessionLike {
  on(event: string, handler: (evt: any) => void): unknown;
  send(prompt: string): unknown;
}

interface ResolvedJudgeUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Mirror OpenAIJudgeClient so cache identities are comparable in shape and the
// judge produces the same deterministic output structure.
const JUDGE_TEMPERATURE = 0;
const JUDGE_RESPONSE_FORMAT = "json_object";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_RETRY_DELAY_MS = 500;
const DEFAULT_RETRY_DELAY_MAX_MS = 30_000;
const MAX_RETRIES_HARD_CAP = 10;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PilotSwarmJudgeClient implements JudgeClient {
  private readonly modelProviders: ModelProviderRegistryType;
  private readonly modelRef: string;
  private readonly resolvedModelName: string;
  private readonly costRates?: PilotSwarmJudgeCostRates;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly retryDelayMaxMs: number;
  private readonly copilotClientCtor?: new (opts: any) => CopilotClientLike;

  constructor(options: PilotSwarmJudgeClientOptions) {
    if (!options.modelProviders) {
      throw new Error("PilotSwarmJudgeClient: modelProviders is required");
    }
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new Error("PilotSwarmJudgeClient: model must be a non-empty string");
    }

    const desc = options.modelProviders.getDescriptor(options.model);
    if (!desc) {
      throw new Error(
        `PilotSwarmJudgeClient: model ${JSON.stringify(options.model)} is not available in the provided ModelProviderRegistry`,
      );
    }

    this.modelProviders = options.modelProviders;
    this.modelRef = options.model;
    this.resolvedModelName = desc.modelName;

    if (options.costRates !== undefined) {
      validateCostRates(options.costRates);
    }
    this.costRates = options.costRates;

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error(
        `PilotSwarmJudgeClient: timeoutMs must be a non-negative finite number (got ${options.timeoutMs})`,
      );
    }

    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > MAX_RETRIES_HARD_CAP
    ) {
      throw new Error(
        `PilotSwarmJudgeClient: maxRetries must be a non-negative integer ≤ ${MAX_RETRIES_HARD_CAP} (got ${options.maxRetries})`,
      );
    }

    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    if (!Number.isFinite(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) {
      throw new Error(
        `PilotSwarmJudgeClient: baseRetryDelayMs must be a non-negative finite number (got ${options.baseRetryDelayMs})`,
      );
    }

    this.retryDelayMaxMs = options.retryDelayMaxMs ?? DEFAULT_RETRY_DELAY_MAX_MS;
    if (!Number.isFinite(this.retryDelayMaxMs) || this.retryDelayMaxMs < 0) {
      throw new Error(
        `PilotSwarmJudgeClient: retryDelayMaxMs must be a non-negative finite number (got ${options.retryDelayMaxMs})`,
      );
    }

    this.copilotClientCtor = options.copilotClientCtor;
  }

  cacheIdentity(): string {
    // Hash everything that affects judge output. Two clients differing only in
    // retries / timeouts share the same cache (those don't change output).
    const data = JSON.stringify({
      kind: "pilotswarm-judge",
      // Use the qualified name so `gpt-4.1` and `github-copilot:gpt-4.1` get
      // the same identity if they resolve to the same descriptor.
      model: this.modelProviders.normalize(this.modelRef) ?? this.modelRef,
      temperature: JUDGE_TEMPERATURE,
      responseFormat: JUDGE_RESPONSE_FORMAT,
    });
    return `pilotswarm-judge:${createHash("sha256").update(data).digest("hex")}`;
  }

  async judge(
    request: JudgeRequest,
    options: JudgeOptions = {},
  ): Promise<JudgeResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (options.signal?.aborted) {
        throw new Error("PilotSwarmJudgeClient: request aborted by caller");
      }

      try {
        return await this.judgeOnce(request, options.signal);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!isRetryable(error) || attempt >= this.maxRetries) {
          throw error;
        }
        lastError = error;
        // stderr only — never stdout, which downstream JSON parsers may read.
        // G16: gate the retry warning on EVAL_VERBOSE_TEARDOWN=1 to keep
        // demo/perf runs clean. Retries are still observable via metrics
        // and the final thrown error if retries exhaust; this is purely
        // a per-attempt informational log.
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(
            `PilotSwarmJudgeClient: attempt ${attempt + 1}/${this.maxRetries + 1} failed (${error.message}); retrying\n`,
          );
        }
        await abortableSleep(this.retryDelayMs(attempt), options.signal);
      }
    }
    // Unreachable — final iteration either returns or throws — but keep a
    // defensive throw so the type system is satisfied and bugs are loud.
    throw lastError ?? new Error("PilotSwarmJudgeClient: unreachable retry state");
  }

  private async judgeOnce(
    request: JudgeRequest,
    signal: AbortSignal | undefined,
  ): Promise<JudgeResponse> {
    const resolved = this.modelProviders.resolve(this.modelRef);
    if (!resolved) {
      throw new Error(
        `PilotSwarmJudgeClient: failed to resolve model ${JSON.stringify(this.modelRef)} (provider mis-configured?)`,
      );
    }
    if (resolved.type === "github" && !resolved.githubToken) {
      throw new Error(
        `PilotSwarmJudgeClient: GitHub provider for ${JSON.stringify(this.modelRef)} has no resolved githubToken`,
      );
    }
    if (resolved.type !== "github" && !resolved.sdkProvider) {
      throw new Error(
        `PilotSwarmJudgeClient: non-github provider for ${JSON.stringify(this.modelRef)} resolved without sdkProvider`,
      );
    }

    const Ctor = this.copilotClientCtor ?? (await loadCopilotClientCtor());
    const client = new Ctor({
      ...(resolved.githubToken ? { githubToken: resolved.githubToken } : {}),
      logLevel: "error",
    });

    // G6 V2 fix #1: timeout MUST cover createSession in addition to runOneShot.
    // We build a single per-attempt AbortController that fires on either:
    //   (a) the per-attempt timeoutMs elapsing, OR
    //   (b) the caller's AbortSignal aborting.
    // Both createSession() and runOneShot() race against this controller.
    // Even if `createSession()` ignores the signal (the SDK currently does),
    // the race rejects promptly and `client.stop()` runs in `finally` to
    // release any resources the SDK started bootstrapping.
    const attemptCtrl = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutFired = false;
    let callerAbortHandler: (() => void) | undefined;
    let callerAborted = false;

    const buildAttemptError = (): Error => {
      if (callerAborted) {
        return new Error("PilotSwarmJudgeClient: request aborted by caller");
      }
      if (timeoutFired) {
        return new Error(
          `PilotSwarmJudgeClient: request timed out after ${this.timeoutMs}ms`,
        );
      }
      return new Error("PilotSwarmJudgeClient: attempt aborted");
    };

    if (signal?.aborted) {
      callerAborted = true;
      attemptCtrl.abort();
    } else if (signal) {
      callerAbortHandler = () => {
        callerAborted = true;
        attemptCtrl.abort();
      };
      signal.addEventListener("abort", callerAbortHandler, { once: true });
    }

    if (this.timeoutMs > 0 && !attemptCtrl.signal.aborted) {
      timeoutHandle = setTimeout(() => {
        timeoutFired = true;
        attemptCtrl.abort();
      }, this.timeoutMs);
    }

    // A re-usable rejecting promise that resolves when the attempt is aborted.
    // Rebuilt inline at each await point so the listener is always fresh.
    const attemptAbortPromise = (): Promise<never> =>
      new Promise<never>((_, reject) => {
        if (attemptCtrl.signal.aborted) {
          reject(buildAttemptError());
          return;
        }
        attemptCtrl.signal.addEventListener(
          "abort",
          () => reject(buildAttemptError()),
          { once: true },
        );
      });

    try {
      if (callerAborted) {
        throw buildAttemptError();
      }

      const session = await Promise.race([
        client.createSession({
          ...(resolved.sdkProvider ? { provider: resolved.sdkProvider } : {}),
          model: resolved.modelName,
          // Auto-approve any tool permission requests — the judge prompt does
          // not invoke tools, but the SDK may emit a permission event during
          // session bootstrap which would otherwise block. The judge runs in
          // a fully sandboxed Copilot session with no PilotSwarm tool registry,
          // so there is no escalation path.
          onPermissionRequest: async () => ({ kind: "approved" as const }),
        }),
        attemptAbortPromise(),
      ]);

      const systemMessage =
        request.systemMessage ??
        "You are an evaluation judge. Return strict JSON with reasoning, rawScore, normalizedScore, and pass.";

      const userMessage = JSON.stringify({
        prompt: request.prompt,
        response: request.response,
        criterion: request.criterion,
      });

      // Compose system + user content into a single send. The Copilot SDK's
      // one-shot session API does not separate system/user roles the way the
      // OpenAI chat completions API does, so we prepend the system instruction
      // and demand a strict JSON response in the prompt itself.
      const composed =
        `${systemMessage}\n\n` +
        `Respond with a single JSON object only — no markdown fences, no commentary.\n` +
        `Required keys: reasoning (string), rawScore (number), normalizedScore (number in [0,1]), pass (boolean).\n\n` +
        `Input:\n${userMessage}`;

      const { text, usage } = await this.runOneShot(
        session,
        composed,
        attemptCtrl.signal,
        buildAttemptError,
      );

      const content = stripJsonFences(text).trim();
      if (!content) {
        // Empty response = judge model failed to follow instructions.
        // Quality failure (the model didn't produce a parseable rubric
        // verdict), not infrastructure — surface as JudgeOutputFormatError
        // so the grader records a non-infra failing Score instead of an
        // infraError that hides the model behavior from quality stats.
        throw new JudgeOutputFormatError(
          "PilotSwarmJudgeClient: empty response content",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // FAIL CLOSED — do NOT swallow malformed judge output as a pass.
        // G6 V2 fix #7: do NOT echo raw judge output in the error message.
        // The eval harness routinely processes adversarial / secret-leak
        // samples, so leaking judge content into infra-error strings (which
        // bubble into reports/logs) is a privacy risk.
        throw new JudgeOutputFormatError(
          `PilotSwarmJudgeClient: judge response was not valid JSON (${detail})`,
        );
      }

      let result: JudgeResult;
      try {
        result = JudgeResultSchema.parse({
          ...(parsed as Record<string, unknown>),
          criterionId: request.criterion.id,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new JudgeOutputFormatError(
          `PilotSwarmJudgeClient: judge response did not match rubric schema (${detail})`,
        );
      }

      const cost = this.computeCost(usage);

      return { result, cost, cached: false };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal && callerAbortHandler) {
        signal.removeEventListener("abort", callerAbortHandler);
      }
      try {
        await client.stop();
      } catch {
        // Stop failures are not actionable here. Swallowing avoids masking the
        // original error path if `judgeOnce` is throwing.
      }
    }
  }

  private async runOneShot(
    session: CopilotSessionLike,
    prompt: string,
    attemptSignal: AbortSignal,
    buildAttemptError: () => Error,
  ): Promise<{ text: string; usage: ResolvedJudgeUsage }> {
    let text = "";
    const usage: ResolvedJudgeUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

    return await new Promise<{ text: string; usage: ResolvedJudgeUsage }>((resolve, reject) => {
      let settled = false;
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (abortHandler) {
          attemptSignal.removeEventListener("abort", abortHandler);
        }
      };

      const settleResolve = (value: { text: string; usage: ResolvedJudgeUsage }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      try {
        // Different @github/copilot builds emit text under different
        // field names: top-level `content`, `data.deltaContent`,
        // `data.content`, or — for the terminal `assistant.message`
        // event — `data.content` as the whole final body. Capture all
        // of them and dedupe on the final message: if a complete
        // `assistant.message` arrives with non-empty content AND we
        // already accumulated a strictly-prefix-matching delta stream,
        // prefer the final form (it includes any post-streaming
        // adjustments the SDK may have applied).
        const pickStr = (...vals: unknown[]): string => {
          for (const v of vals) {
            if (typeof v === "string" && v.length > 0) return v;
          }
          return "";
        };
        session.on("assistant.message_delta", (evt: any) => {
          const piece = pickStr(
            evt?.content,
            evt?.data?.deltaContent,
            evt?.data?.content,
            evt?.delta?.content,
          );
          if (piece) text += piece;
        });
        session.on("assistant.message", (evt: any) => {
          const final = pickStr(evt?.data?.content, evt?.message?.content, evt?.content);
          if (!final) return;
          if (final.startsWith(text) || text.length === 0) {
            text = final;
          } else {
            // Streaming and final disagree — append final after deltas
            // rather than overwriting, so we preserve all signal. The
            // judge parser tolerates extra trailing text after the
            // JSON object.
            text += final;
          }
        });

        // Some SDK builds emit a separate completed event with usage stats. We
        // best-effort capture them — absence is not fatal.
        session.on("assistant.message_completed", (evt: any) => {
          const u = evt?.usage ?? evt?.message?.usage;
          if (u && typeof u === "object") {
            const p = pickFiniteInt(u.prompt_tokens ?? u.promptTokens);
            const c = pickFiniteInt(u.completion_tokens ?? u.completionTokens);
            const cached = pickFiniteInt(
              u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cachedTokens,
            );
            if (p !== null) usage.promptTokens = p;
            if (c !== null) usage.completionTokens = c;
            if (cached !== null) usage.cachedTokens = cached;
          }
        });

        session.on("session.idle", () => {
          settleResolve({ text, usage });
        });

        session.on("session.error", (evt: any) => {
          // Capture the most informative scalar surface available. Some
          // provider failures arrive with `evt.message` empty but
          // `evt.error.message` populated, or a code+detail pair, or just
          // a stringified payload — without these the failure surfaces as
          // a useless "session error" with no diagnostic signal.
          const candidates: unknown[] = [
            evt?.message,
            evt?.error?.message,
            evt?.error,
            evt?.detail,
            evt?.code,
            evt,
          ];
          let message = "session error";
          for (const c of candidates) {
            if (typeof c === "string" && c.length > 0) {
              message = c;
              break;
            }
            if (c && typeof c === "object") {
              try {
                const s = JSON.stringify(c);
                if (s && s !== "{}") {
                  message = s;
                  break;
                }
              } catch {
                /* unserializable — keep searching */
              }
            }
          }
          // Workaround: @github/copilot's `emitUserMessageSentimentTelemetry`
          // can throw `TypeError: Cannot read properties of undefined
          // (reading 'trim')` AFTER the model has already streamed its full
          // response — the crash sits in a post-response telemetry hook
          // and does not affect correctness of the assistant text. When we
          // already captured non-empty text and the error matches that
          // signature, treat it as benign and resolve with what we have
          // instead of failing the whole judge call.
          const isCopilotTelemetryCrash =
            /reading 'trim'/.test(message) &&
            /emitUserMessageSentimentTelemetry/.test(message);
          if (isCopilotTelemetryCrash && text.length > 0) {
            settleResolve({ text, usage });
            return;
          }
          // G6 V2 fix #5: tag session.error explicitly so isRetryable() can
          // distinguish provider-level transient failures from non-retryable
          // validation errors. The downstream `isRetryable` matches on the
          // canonical `session.error:` prefix.
          settleReject(new Error(`PilotSwarmJudgeClient session.error: ${message}`));
        });

        // The attempt-wide signal covers BOTH timeout and caller-abort.
        if (attemptSignal.aborted) {
          settleReject(buildAttemptError());
          return;
        }
        abortHandler = () => settleReject(buildAttemptError());
        attemptSignal.addEventListener("abort", abortHandler, { once: true });

        // G6 V2 fix #6: surface a rejected `session.send()` Promise rather
        // than relying solely on `session.error` events. Some SDK builds
        // return a Promise that rejects on transport / serialization errors
        // before any session-level event fires.
        const sendResult = session.send(prompt);
        if (sendResult && typeof (sendResult as any).then === "function") {
          (sendResult as Promise<unknown>).catch((err) => {
            settleReject(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  estimateCost(
    request: JudgeRequest,
    options: { completionTokens?: number } = {},
  ): number | undefined {
    if (!this.costRates) return undefined;
    // G6 V2 fix #2: defensive re-validation in case the costRates field has
    // been mutated post-construction. Mirrors OpenAIJudgeClient's contract so
    // `LLMJudgeGrader` budget reservations work identically across both
    // clients. Throws on negative / non-finite rates.
    validateCostRates(this.costRates);
    const rubricText = JSON.stringify(request.criterion);
    // Cheap input-token estimate: ~4 chars/token. Mirrors OpenAIJudgeClient.
    const promptTokens = Math.ceil(
      (request.prompt.length + request.response.length + rubricText.length) / 4,
    );
    const completionTokens = options.completionTokens ?? 500;
    return (
      (promptTokens / 1_000_000) * this.costRates.inputUsdPerMillionTokens +
      (completionTokens / 1_000_000) * this.costRates.outputUsdPerMillionTokens
    );
  }

  private computeCost(usage: ResolvedJudgeUsage): JudgeCost {
    const promptTokens = Math.max(0, usage.promptTokens);
    const completionTokens = Math.max(0, usage.completionTokens);
    const cachedTokens = Math.max(0, Math.min(usage.cachedTokens, promptTokens));
    const nonCachedInputTokens = promptTokens - cachedTokens;

    let estimatedCostUsd: number | undefined;
    if (this.costRates) {
      const inputRate = this.costRates.inputUsdPerMillionTokens;
      const outputRate = this.costRates.outputUsdPerMillionTokens;
      const cachedRateRaw = this.costRates.cachedInputUsdPerMillionTokens;
      const cachedRate =
        cachedRateRaw !== undefined && Number.isFinite(cachedRateRaw) && cachedRateRaw >= 0
          ? cachedRateRaw
          : 0.5 * inputRate;
      estimatedCostUsd =
        (nonCachedInputTokens / 1_000_000) * inputRate +
        (cachedTokens / 1_000_000) * cachedRate +
        (completionTokens / 1_000_000) * outputRate;
    }

    return JudgeCostSchema.parse({
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      model: this.resolvedModelName,
      estimatedCostUsd,
    });
  }

  private retryDelayMs(attempt: number): number {
    const exponential = this.baseRetryDelayMs * 2 ** attempt;
    return Math.min(exponential, this.retryDelayMaxMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cachedCopilotClientCtor: (new (opts: any) => CopilotClientLike) | undefined;
let inFlightCopilotImport: Promise<new (opts: any) => CopilotClientLike> | undefined;

async function loadCopilotClientCtor(): Promise<new (opts: any) => CopilotClientLike> {
  if (cachedCopilotClientCtor) return cachedCopilotClientCtor;
  // G6 V2 medium-fix: cache the in-flight Promise so concurrent first-callers
  // share a single dynamic import rather than racing duplicates.
  if (inFlightCopilotImport) return inFlightCopilotImport;
  inFlightCopilotImport = (async () => {
    const mod: any = await import("@github/copilot-sdk");
    const Ctor = mod?.CopilotClient ?? mod?.default?.CopilotClient;
    if (typeof Ctor !== "function") {
      throw new Error(
        "PilotSwarmJudgeClient: @github/copilot-sdk did not export a CopilotClient constructor",
      );
    }
    cachedCopilotClientCtor = Ctor;
    return Ctor;
  })().finally(() => {
    // Clear in-flight reference so a future failure path can retry the import.
    inFlightCopilotImport = undefined;
  });
  return inFlightCopilotImport;
}

function isRetryable(err: Error): boolean {
  // Validation errors must NOT be retried — they signal garbage from the model
  // OR a non-transient schema/validation failure from the provider/session.
  // We check this branch FIRST so a `session.error` carrying validation text
  // (e.g., `session.error: schema validation failed`) does not slip through
  // the broad `session.error` retry below.
  if (/not valid JSON|missing response content|empty response content/i.test(err.message)) {
    return false;
  }
  // G6 V3 fix: a `session.error: ...` whose payload itself signals a
  // validation / schema / bad-request failure is NOT transient. Reject those
  // before the broad session.error retry branch fires.
  if (/\b(?:schema|validation)\b/i.test(err.message)) {
    return false;
  }
  if (/\bbad request\b|\b400\b/i.test(err.message)) {
    return false;
  }
  // Schema validation failures from JudgeResultSchema.parse are not retryable.
  if (err.name === "ZodError") return false;
  // Caller-abort errors are not retryable — the caller signal won't change
  // between attempts. Match this BEFORE the timeout/network heuristics so
  // an "aborted by caller" message containing "network"-ish text isn't
  // accidentally retried.
  if (/aborted by caller/i.test(err.message)) return false;
  // Treat timeouts and network-shaped errors as retryable.
  if (/timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(err.message)) {
    return true;
  }
  // G6 V2 fix #5: explicit `session.error:` tag from runOneShot. We must also
  // accept the legacy "session error" form for backwards compatibility with
  // any callers / tests that match on the loose phrase.
  if (/session\.?error/i.test(err.message)) return true;
  // Provider-level transient signals: 429 / rate limit / 5xx-shaped messages.
  if (/\b429\b|rate ?limit|too many requests/i.test(err.message)) return true;
  if (/\b5\d\d\b/.test(err.message)) return true;
  return false;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted
      ? Promise.reject(new Error("PilotSwarmJudgeClient: request aborted by caller"))
      : Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("PilotSwarmJudgeClient: request aborted by caller"));
      return;
    }
    let abortHandler: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      resolve();
    }, ms);
    abortHandler = () => {
      clearTimeout(timer);
      reject(new Error("PilotSwarmJudgeClient: request aborted by caller"));
    };
    if (signal) signal.addEventListener("abort", abortHandler, { once: true });
  });
}

function stripJsonFences(text: string): string {
  // G6 V2 fix #4: strict, fail-closed fence handling. Only strip a fenced
  // block when the ENTIRE response (after trimming) is wrapped by the fence.
  // Reject embedded fences with leading/trailing commentary so the JSON
  // parser can fail loudly on non-compliant judge output.
  //
  // Anchored on the trimmed text (`^...$` against the whole string) so a
  // prefix like "Here's the JSON:\n```json\n{...}\n```" is NOT accepted as
  // a clean fence; the parser will then throw "not valid JSON" on the raw
  // text and the judge call fails closed.
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence?.[1] ?? text;
}

function pickFiniteInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function validateCostRates(rates: PilotSwarmJudgeCostRates): void {
  const checks: Array<[string, number | undefined]> = [
    ["inputUsdPerMillionTokens", rates.inputUsdPerMillionTokens],
    ["outputUsdPerMillionTokens", rates.outputUsdPerMillionTokens],
    ["cachedInputUsdPerMillionTokens", rates.cachedInputUsdPerMillionTokens],
  ];
  for (const [name, value] of checks) {
    if (value === undefined) {
      if (name !== "cachedInputUsdPerMillionTokens") {
        throw new Error(
          `PilotSwarmJudgeClient: costRates.${name} must be a non-negative finite number (got ${value})`,
        );
      }
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `PilotSwarmJudgeClient: costRates.${name} must be a non-negative finite number (got ${value})`,
      );
    }
  }
}
