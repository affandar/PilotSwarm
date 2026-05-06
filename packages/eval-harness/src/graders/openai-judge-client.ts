import { createHash } from "node:crypto";
import {
  JudgeCostSchema,
  JudgeResultSchema,
  type JudgeCost,
  type JudgeResult,
} from "../types.js";
import type { JudgeClient, JudgeOptions, JudgeRequest, JudgeResponse } from "./judge-types.js";
import { JudgeOutputFormatError } from "./judge-types.js";

type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  text?: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export interface OpenAIJudgeCostRates {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  /**
   * F22: per-million-token rate for prompt tokens that the provider reports as
   * cached (e.g. OpenAI `usage.prompt_tokens_details.cached_tokens`). When
   * omitted, defaults to `0.5 * inputUsdPerMillionTokens`. Set to `0` to bill
   * cached tokens at zero. Must be non-negative and finite.
   */
  cachedInputUsdPerMillionTokens?: number;
}

export interface OpenAIJudgeClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  costRates?: OpenAIJudgeCostRates;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  /**
   * Upper bound for any retry delay, including server-supplied
   * `Retry-After` headers. Prevents a hostile or misconfigured server
   * from pinning the client for hours/days. Defaults to 30_000 (30s).
   */
  retryDelayMaxMs?: number;
  timeoutMs?: number;
}

interface OpenAIResponse {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * F22: cached prompt-token breakdown reported by OpenAI-compatible
     * providers. When present, `cached_tokens` is a subset of
     * `prompt_tokens` that hit the provider's prompt cache and is billed at
     * the cached rate.
     */
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_RETRY_DELAY_MAX_MS = 30_000;
/**
 * F17: hard upper bound on retry attempts. Prevents pathological
 * configurations (e.g. `maxRetries: Infinity`) from spinning the client
 * for thousands of attempts before giving up. Chosen as a high but finite
 * cap that still allows aggressive retry policies for production judges.
 */
const MAX_RETRIES_HARD_CAP = 10;
// Hardcoded judge request shape — kept in sync with the request body below.
// Surfaced via cacheIdentity() to differentiate cache entries across configs.
const JUDGE_TEMPERATURE = 0;
const JUDGE_RESPONSE_FORMAT = "json_object";

export class OpenAIJudgeClient implements JudgeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly costRates?: OpenAIJudgeCostRates;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly retryDelayMaxMs: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAIJudgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    if (options.costRates !== undefined) {
      validateCostRates(options.costRates);
    }
    this.costRates = options.costRates;
    this.maxRetries = options.maxRetries ?? 3;
    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0 ||
      this.maxRetries > MAX_RETRIES_HARD_CAP
    ) {
      throw new Error(
        `OpenAIJudgeClient: maxRetries must be a non-negative integer ≤ ${MAX_RETRIES_HARD_CAP} (got ${options.maxRetries})`,
      );
    }
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    if (!Number.isFinite(this.baseRetryDelayMs) || this.baseRetryDelayMs < 0) {
      throw new Error(
        `OpenAIJudgeClient: baseRetryDelayMs must be a non-negative finite number (got ${options.baseRetryDelayMs})`,
      );
    }
    this.retryDelayMaxMs = options.retryDelayMaxMs ?? DEFAULT_RETRY_DELAY_MAX_MS;
    if (!Number.isFinite(this.retryDelayMaxMs) || this.retryDelayMaxMs < 0) {
      throw new Error(
        `OpenAIJudgeClient: retryDelayMaxMs must be a non-negative finite number (got ${this.retryDelayMaxMs})`,
      );
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error(
        `OpenAIJudgeClient: timeoutMs must be a non-negative finite number (got ${options.timeoutMs})`,
      );
    }
    const globalFetch = globalThis.fetch as unknown as FetchLike | undefined;
    this.fetchImpl = options.fetch ?? globalFetch ?? (() => {
      throw new Error("OpenAIJudgeClient: fetch is not available");
    });
  }

  /**
   * Stable identity for cache keying. Combines all configuration that affects
   * judge output, so that LLMJudgeGrader can detect mismatched judge configs
   * sharing one cache and avoid cross-poisoning.
   */
  cacheIdentity(): string {
    const data = JSON.stringify({
      kind: "openai-judge",
      model: this.model,
      temperature: JUDGE_TEMPERATURE,
      responseFormat: JUDGE_RESPONSE_FORMAT,
    });
    return `openai-judge:${createHash("sha256").update(data).digest("hex")}`;
  }

  async judge(request: JudgeRequest, options: JudgeOptions = {}): Promise<JudgeResponse> {
    const resp = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: JUDGE_TEMPERATURE,
        response_format: { type: JUDGE_RESPONSE_FORMAT },
        messages: [
          {
            role: "system",
            content:
              request.systemMessage ??
              "You are an evaluation judge. Return strict JSON with reasoning, rawScore, normalizedScore, and pass.",
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt: request.prompt,
              response: request.response,
              criterion: request.criterion,
            }),
          },
        ],
      }),
    }, options.signal);

    const json = await resp.json() as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      // Empty response = model failed to produce rubric output. Quality
      // failure, not infrastructure: see JudgeOutputFormatError docs.
      throw new JudgeOutputFormatError(
        "OpenAIJudgeClient: missing response content",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new JudgeOutputFormatError(
        `OpenAIJudgeClient: judge response was not valid JSON (${detail})`,
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
        `OpenAIJudgeClient: judge response did not match rubric schema (${detail})`,
      );
    }
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    // F22: split prompt tokens into cached vs non-cached components and bill
    // them at separate rates. Cached tokens are typically charged at ~50% of
    // the input rate by OpenAI; we default `cachedRate` to half of
    // `inputUsdPerMillionTokens` when not explicitly configured. We clamp
    // `cachedTokens` into `[0, inputTokens]` to defend against malformed
    // provider responses (e.g. cached_tokens > prompt_tokens).
    const reportedCachedTokens = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cachedTokens = Math.max(
      0,
      Math.min(reportedCachedTokens, inputTokens),
    );
    const nonCachedInputTokens = inputTokens - cachedTokens;
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
        (outputTokens / 1_000_000) * outputRate;
    }
    const cost: JudgeCost = JudgeCostSchema.parse({
      inputTokens,
      outputTokens,
      model: this.model,
      estimatedCostUsd,
    });

    return { result, cost, cached: false };
  }

  estimateCost(
    request: JudgeRequest,
    options: { completionTokens?: number } = {},
  ): number | undefined {
    if (!this.costRates) return undefined;
    // F12: defensive re-validation in case the costRates field has been
    // mutated post-construction. Throws on negative / non-finite rates.
    validateCostRates(this.costRates);
    const rubricText = JSON.stringify(request.criterion);
    const promptTokens = Math.ceil(
      (request.prompt.length + request.response.length + rubricText.length) / 4,
    );
    const completionTokens = options.completionTokens ?? 500;
    return (
      (promptTokens / 1_000_000) * this.costRates.inputUsdPerMillionTokens +
      (completionTokens / 1_000_000) * this.costRates.outputUsdPerMillionTokens
    );
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    let firstRetryableError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (callerSignal?.aborted) {
        throw new Error("OpenAIJudgeClient: request aborted by caller");
      }

      const controller = new AbortController();
      let timedOut = false;
      let callerAborted = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let callerAbortHandler: (() => void) | undefined;

      if (this.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);
      }

      if (callerSignal) {
        callerAbortHandler = () => {
          callerAborted = true;
          controller.abort();
        };
        callerSignal.addEventListener("abort", callerAbortHandler, { once: true });
      }

      let resp: Awaited<ReturnType<FetchLike>>;
      try {
        resp = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (callerAborted || callerSignal?.aborted) {
          throw new Error(`OpenAIJudgeClient: request aborted by caller: ${error.message}`);
        }
        const retryable = timedOut;
        const retryableError = timedOut
          ? new Error(`OpenAIJudgeClient: request timed out after ${this.timeoutMs}ms`)
          : error;
        if (!retryable) throw retryableError;
        firstRetryableError ??= retryableError;
        if (attempt >= this.maxRetries) throw firstRetryableError;
        await this.abortableSleep(this.retryDelayMs(undefined, attempt), callerSignal);
        continue;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (callerSignal && callerAbortHandler) {
          callerSignal.removeEventListener("abort", callerAbortHandler);
        }
      }

      if (resp.ok) return resp;

      const status = resp.status ?? 0;
      const body = resp.text ? await resp.text().catch(() => "") : "";
      const err = new Error(`OpenAIJudgeClient: request failed (${status || "unknown"}): ${body}`);
      const retryable = status === 429 || status >= 500;
      if (!retryable) throw err;
      firstRetryableError ??= err;
      if (attempt >= this.maxRetries) throw firstRetryableError;
      await this.abortableSleep(this.retryDelayMs(resp, attempt), callerSignal);
    }
    throw new Error("OpenAIJudgeClient: unreachable retry state");
  }

  private retryDelayMs(resp: Awaited<ReturnType<FetchLike>> | undefined, attempt: number): number {
    const retryAfter = resp?.headers?.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        // F19: cap server-supplied delay so a hostile/misconfigured server
        // cannot pin the client for hours.
        return Math.min(seconds * 1000, this.retryDelayMaxMs);
      }
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        const delta = Math.max(0, dateMs - Date.now());
        return Math.min(delta, this.retryDelayMaxMs);
      }
    }
    // Base-2 exponential backoff keeps judge retries within typical eval sample
    // timeout budgets while still backing off on rate limits/transient 5xxs.
    const exponential = this.baseRetryDelayMs * (2 ** attempt);
    return Math.min(exponential, this.retryDelayMaxMs);
  }

  /**
   * F19: sleep that wakes early on caller abort. If the signal fires during
   * the sleep, throws `OpenAIJudgeClient: request aborted by caller`
   * immediately rather than waiting out the full delay.
   */
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
      if (signal?.aborted) {
        return Promise.reject(new Error("OpenAIJudgeClient: request aborted by caller"));
      }
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("OpenAIJudgeClient: request aborted by caller"));
        return;
      }
      let abortHandler: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve();
      }, ms);
      abortHandler = () => {
        clearTimeout(timer);
        reject(new Error("OpenAIJudgeClient: request aborted by caller"));
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }
}

/**
 * F12: validate cost rates. All rates must be finite and non-negative.
 * Throws a clear error otherwise so misconfiguration cannot silently
 * produce negative cost estimates downstream.
 */
function validateCostRates(rates: OpenAIJudgeCostRates): void {
  const checks: Array<[string, number | undefined]> = [
    ["inputUsdPerMillionTokens", rates.inputUsdPerMillionTokens],
    ["outputUsdPerMillionTokens", rates.outputUsdPerMillionTokens],
    ["cachedInputUsdPerMillionTokens", rates.cachedInputUsdPerMillionTokens],
  ];
  for (const [name, value] of checks) {
    if (value === undefined) {
      // inputUsdPerMillionTokens / outputUsdPerMillionTokens are required by
      // the type, but defend against bad casts at runtime.
      if (name !== "cachedInputUsdPerMillionTokens") {
        throw new Error(
          `OpenAIJudgeClient: costRates.${name} must be a non-negative finite number (got ${value})`,
        );
      }
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `OpenAIJudgeClient: costRates.${name} must be a non-negative finite number (got ${value})`,
      );
    }
  }
}
