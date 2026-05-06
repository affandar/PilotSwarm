import { createHash } from "node:crypto";
import type {
  JudgeClient,
  JudgeCache,
  JudgeRequest,
  JudgeResponse,
} from "./judge-types.js";
import { JudgeOutputFormatError } from "./judge-types.js";
import {
  JudgeResultSchema,
  JudgeCostSchema,
  RubricSchema,
  type JudgeCost,
  type JudgeResult,
  type Rubric,
  type RubricCriterion,
  type Score,
} from "../types.js";

export interface LLMJudgeGraderOptions {
  client: JudgeClient;
  rubric: Rubric;
  /**
   * Spending limit for this grader instance, in USD.
   * - `undefined` (omitted): unlimited spend.
   * - `0` (explicit): deny-all — every grade call returns infraError without
   *   estimating or invoking the judge client.
   * - `> 0`: hard cap; criteria refuse once cumulative spend reaches the cap.
   */
  budgetUsd?: number;
  cache?: JudgeCache;
  judgeId?: string;
  systemMessage?: string;
  judgeCompletionTokenEstimate?: number;
}

export interface LLMJudgeGradeResult {
  scores: Score[];
  costs: JudgeCost[];
  totalCostUsd: number;
}

const DEFAULT_JUDGE_ID = "default";

/**
 * Per-criterion outcome shape used internally by the singleflight cache.
 * One outcome shape covers both successful judge results and structured
 * infraError sentinels so concurrent callers waiting on the same cache key
 * receive identical results.
 */
type CriterionOutcome =
  | { kind: "ok"; score: Score; cost: JudgeCost }
  | { kind: "infraError"; score: Score }
  | { kind: "computed"; score: Score };

/**
 * Rubric-based judge grader. The package bundles deterministic and
 * OpenAI-compatible clients, but no default calibrated judge is selected for
 * users; callers must provide and validate an appropriate JudgeClient.
 */
export class LLMJudgeGrader {
  private client: JudgeClient;
  private rubric: Rubric;
  /**
   * Internal budget. `undefined` means unlimited. `0` means deny-all
   * (refuse every grade call). A positive number is a hard cap.
   */
  private budgetUsd: number | undefined;
  private cache?: JudgeCache;
  private judgeId: string;
  private systemMessage?: string;
  private judgeCompletionTokenEstimate: number;
  private totalCostUsd = 0;
  /**
   * F15: in-flight singleflight map. Concurrent grade() calls that resolve
   * to the same cache key share a single CriterionOutcome promise so the
   * underlying judge client is only invoked once. Entries are removed in a
   * `finally` block (both success and rejection) so future callers can retry.
   */
  private inflight: Map<string, Promise<CriterionOutcome>> = new Map();
  /**
   * F16: serialization mutex for budget reservation. Reading totalCostUsd,
   * comparing to the cap, and reserving the estimated cost must happen
   * atomically so two concurrent calls cannot both pass the budget gate
   * before either records its spend. Implemented as a Promise chain — each
   * reservation awaits the previous one before performing its check + write.
   */
  private budgetMutex: Promise<void> = Promise.resolve();

  constructor(options: LLMJudgeGraderOptions) {
    this.rubric = RubricSchema.parse(options.rubric);
    this.client = options.client;
    if (options.budgetUsd !== undefined && (!Number.isFinite(options.budgetUsd) || options.budgetUsd < 0)) {
      throw new Error(
        `LLMJudgeGrader: budgetUsd must be a non-negative finite number or undefined (got ${options.budgetUsd})`,
      );
    }
    this.budgetUsd = options.budgetUsd;
    this.cache = options.cache;
    if (options.cache !== undefined) {
      if (options.judgeId === undefined || options.judgeId === DEFAULT_JUDGE_ID) {
        throw new Error(
          "LLMJudgeGrader: judgeId must be set to a stable, non-default value when a cache is supplied " +
            "(omitted or \"default\" judgeId can poison shared caches across judge configurations)",
        );
      }
    }
    this.judgeId = options.judgeId ?? DEFAULT_JUDGE_ID;
    this.systemMessage = options.systemMessage;
    this.judgeCompletionTokenEstimate = options.judgeCompletionTokenEstimate ?? 500;
  }

  async grade(prompt: string, response: string): Promise<LLMJudgeGradeResult> {
    const scores: Score[] = [];
    const costs: JudgeCost[] = [];

    for (const criterion of this.rubric.criteria) {
      const outcome = await this.gradeCriterion(prompt, response, criterion);
      scores.push(outcome.score);
      if (outcome.kind === "ok") {
        costs.push(outcome.cost);
      }
    }

    return { scores, costs, totalCostUsd: this.totalCostUsd };
  }

  /**
   * Grade a single criterion through the singleflight inflight cache.
   * Concurrent calls with the same cacheKey reuse a single underlying
   * promise so the judge client is invoked at most once per (key, run).
   */
  private gradeCriterion(
    prompt: string,
    response: string,
    criterion: RubricCriterion,
  ): Promise<CriterionOutcome> {
    const cacheKey = this.buildCacheKey(prompt, response, criterion);
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const promise = this.doGradeCriterion(cacheKey, prompt, response, criterion)
      .finally(() => {
        // Always evict, on success and rejection, so future callers retry.
        this.inflight.delete(cacheKey);
      });
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  private async doGradeCriterion(
    cacheKey: string,
    prompt: string,
    response: string,
    criterion: RubricCriterion,
  ): Promise<CriterionOutcome> {
    // F18: explicit budgetUsd === 0 means deny-all. No estimate, no client call,
    // no cache lookup.
    if (this.budgetUsd === 0) {
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: "Budget denied (budgetUsd=0): judge spend not permitted",
          infraError: true,
          infraSource: "judge",
        },
      };
    }

    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          const cachedParse = JudgeResultSchema.safeParse(cached.result);
          const cachedCostParse = JudgeCostSchema.safeParse(cached.cost);
          if (
            cachedParse.success &&
            cachedCostParse.success &&
            cachedCostParse.data.estimatedCostUsd !== undefined
          ) {
            return {
              kind: "ok",
              score: this.resultToScore(cachedParse.data, criterion),
              cost: cachedCostParse.data,
            };
          }
          // Invalid cache entry — fall through to fresh judge call
        }
      } catch (cacheErr) {
        console.warn(
          `[LLMJudgeGrader] cache.get failed: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
        // Fall through to judge call
      }
    }

    const judgeRequest: JudgeRequest = {
      prompt,
      response,
      criterion,
      ...(this.systemMessage !== undefined ? { systemMessage: this.systemMessage } : {}),
    };

    const preCallEstimate = this.client.estimateCost?.(judgeRequest, {
      completionTokens: this.judgeCompletionTokenEstimate,
    });

    // F16: serialize the budget reservation so concurrent calls cannot both
    // pass the cap check before either has recorded its spend.
    const reservation = await this.reserveBudget(preCallEstimate);
    if (reservation.kind === "denied") {
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: reservation.reason,
          infraError: true,
          infraSource: "judge",
        },
      };
    }

    let judgeResponse: JudgeResponse;
    try {
      judgeResponse = await this.client.judge(judgeRequest);
    } catch (err) {
      // F16: refund the reservation so a transient client failure does not
      // permanently consume budget.
      this.totalCostUsd -= reservation.reserved;
      // JudgeOutputFormatError = the judge model returned, billable tokens
      // were spent, but its output couldn't be parsed into the rubric
      // schema. That is a *quality* signal about the judge model itself
      // (failed to follow rubric instructions), NOT an infra outage. Tag
      // it as a failing-but-non-infra score so the eval still produces
      // pass-rate signal for the case under judgment.
      if (err instanceof JudgeOutputFormatError) {
        return {
          kind: "computed",
          score: {
            name: `judge/${criterion.id}`,
            value: 0,
            pass: false,
            reason: `Judge output unparseable: ${err.message}`,
            infraError: false,
          },
        };
      }
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: `Judge unavailable: ${err instanceof Error ? err.message : String(err)}`,
          infraError: true,
          infraSource: "judge",
        },
      };
    }

    const costParse = JudgeCostSchema.safeParse(judgeResponse.cost);
    if (!costParse.success) {
      this.totalCostUsd -= reservation.reserved;
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: `Invalid judge cost: ${costParse.error.message}`,
          infraError: true,
          infraSource: "judge",
        },
      };
    }
    const validCost: JudgeCost = costParse.data;
    if (validCost.estimatedCostUsd === undefined) {
      this.totalCostUsd -= reservation.reserved;
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: "cost unknown — pass costRates to OpenAIJudgeClient",
          infraError: true,
          infraSource: "judge",
        },
      };
    }
    // F16: reconcile the reservation against the actual cost so post-facto
    // accounting matches what the client really spent. H4 (iter19): perform
    // the reconcile under the budget mutex AND fail the call (refunding the
    // delta) if the actual cost would push cumulative spend above the cap.
    const reconcile = await this.reconcileBudget(
      reservation.reserved,
      validCost.estimatedCostUsd,
    );
    if (reconcile.kind === "denied") {
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: reconcile.reason,
          infraError: true,
          infraSource: "judge",
        },
      };
    }

    const resultParse = JudgeResultSchema.safeParse(judgeResponse.result);
    if (!resultParse.success) {
      return {
        kind: "infraError",
        score: {
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: `Invalid judge result: ${resultParse.error.message}`,
          infraError: true,
          infraSource: "judge",
        },
      };
    }

    if (this.cache) {
      try {
        await this.cache.set(cacheKey, {
          ...judgeResponse,
          result: resultParse.data,
          cost: validCost,
        });
      } catch (cacheErr) {
        console.warn(
          `[LLMJudgeGrader] cache.set failed: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
        );
      }
    }

    return {
      kind: "ok",
      score: this.resultToScore(resultParse.data, criterion),
      cost: validCost,
    };
  }

  /**
   * F16: atomically check-then-reserve budget under a Promise-chain mutex.
   * If the cap is unset, returns a zero-cost reservation and skips the
   * mutex entirely (no contention possible).
   *
   * Returns `{ kind: "ok", reserved }` when the call may proceed; the
   * `reserved` amount has already been added to `totalCostUsd` and must be
   * refunded by the caller on failure or reconciled against the actual
   * cost on success.
   */
  private reserveBudget(
    preCallEstimate: number | undefined,
  ): Promise<
    | { kind: "ok"; reserved: number }
    | { kind: "denied"; reason: string }
  > {
    const cap = this.budgetUsd;
    if (cap === undefined) {
      return Promise.resolve({ kind: "ok", reserved: 0 });
    }

    const next = this.budgetMutex.then(():
      | { kind: "ok"; reserved: number }
      | { kind: "denied"; reason: string } => {
      if (this.totalCostUsd >= cap) {
        return {
          kind: "denied",
          reason: `Budget exceeded (${this.totalCostUsd.toFixed(4)} >= ${cap} USD)`,
        };
      }
      const estimate =
        preCallEstimate !== undefined && Number.isFinite(preCallEstimate)
          ? preCallEstimate
          : undefined;
      if (estimate !== undefined && this.totalCostUsd + estimate >= cap) {
        return {
          kind: "denied",
          reason: "would exceed budget pre-call estimate",
        };
      }
      const reserved = estimate ?? 0;
      this.totalCostUsd += reserved;
      return { kind: "ok", reserved };
    });

    // The mutex itself never rejects — swallow any error here so a failed
    // reservation cannot poison the chain for subsequent reservations.
    this.budgetMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * H4 (iter19): reconcile a previously-reserved estimate against the actual
   * cost, atomically under the budget mutex. If the actual cost would push
   * cumulative spend over the cap, the reservation is fully refunded and the
   * call is denied (caller must surface as infraError). On success the delta
   * (actual - reserved) is added so cumulative spend reflects reality.
   */
  private reconcileBudget(
    reserved: number,
    actual: number,
  ): Promise<
    | { kind: "ok" }
    | { kind: "denied"; reason: string }
  > {
    const cap = this.budgetUsd;
    if (cap === undefined) {
      // Unlimited — just record the actual cost (no reservation tracking).
      this.totalCostUsd += actual - reserved;
      return Promise.resolve({ kind: "ok" });
    }

    const next = this.budgetMutex.then(():
      | { kind: "ok" }
      | { kind: "denied"; reason: string } => {
      // Compute the spend the reservation would imply at actual cost.
      const projected = this.totalCostUsd - reserved + actual;
      if (projected > cap + 1e-9) {
        // Refund the reservation so the would-be charge is fully reversed.
        this.totalCostUsd -= reserved;
        return {
          kind: "denied",
          reason:
            `Budget exceeded after reconcile (actual ${actual.toFixed(4)}; ` +
            `would push cumulative spend to ${projected.toFixed(4)} >= cap ${cap})`,
        };
      }
      this.totalCostUsd += actual - reserved;
      return { kind: "ok" };
    });

    this.budgetMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  get cumulativeCostUsd(): number {
    return this.totalCostUsd;
  }

  private resultToScore(result: JudgeResult, criterion: RubricCriterion): Score {
    return {
      name: `judge/${criterion.id}`,
      value: result.normalizedScore,
      pass: result.normalizedScore >= criterion.passThreshold,
      reason: result.reasoning,
    };
  }

  private buildCacheKey(
    prompt: string,
    response: string,
    criterion: RubricCriterion,
  ): string {
    const clientIdentity = this.client.cacheIdentity?.();
    // F21 + F11 (iter16): include canonicalized criterion content (description,
    // scale, passThreshold, version, anchors) so that two criteria sharing one
    // id but with different definitions cannot share a cache entry. Anchors are
    // canonicalized via canonicalJSON so insertion order does not change the
    // cache key.
    const canonicalCriterion = {
      id: criterion.id,
      description: criterion.description,
      scale: criterion.scale,
      passThreshold: criterion.passThreshold,
      version: (criterion as { version?: unknown }).version ?? null,
      anchors: criterion.anchors ?? null,
    };
    const criterionHash = createHash("sha256")
      .update(canonicalJSON(canonicalCriterion))
      .digest("hex");
    const data = JSON.stringify({
      judgeId: this.judgeId,
      // F6: include client cache identity (model + temperature + format etc.)
      // so that two graders sharing one cache cannot collide on different
      // judge configurations. `null` for clients that don't implement it.
      clientIdentity: clientIdentity ?? null,
      systemMessage:
        this.systemMessage === undefined
          ? { kind: "undefined" }
          : {
              kind: "value",
              sha256: createHash("sha256").update(this.systemMessage).digest("hex"),
            },
      rubricId: this.rubric.id,
      rubricVersion: this.rubric.version,
      criterionId: criterion.id,
      // F21: criterion content hash
      criterionContentHash: criterionHash,
      prompt,
      response,
    });
    return `judge_${createHash("sha256").update(data).digest("hex")}`;
  }
}

/**
 * Canonical JSON serializer: emits object keys in lexicographic order at every
 * level so that semantically-equal objects produce byte-identical output
 * regardless of insertion order. Arrays preserve order. Used to derive stable
 * content hashes for cache keys.
 */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}
