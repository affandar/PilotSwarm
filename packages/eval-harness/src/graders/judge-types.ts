import type { Rubric, RubricCriterion, JudgeResult, JudgeCost } from "../types.js";

/**
 * Thrown by JudgeClient implementations when the judge model returned a
 * response but it could not be parsed into the expected rubric schema —
 * e.g. malformed JSON, missing required fields, wrong types, or prose
 * that ignored the response-format instructions.
 *
 * The grader treats this distinct from infrastructure failures: the call
 * reached the model, billable tokens were spent, and the response is
 * quality evidence about the judge model itself. It surfaces as a
 * non-infra failing Score (`pass: false, infraError: false`) rather
 * than an infraError that would exclude the case from quality
 * aggregates.
 */
export class JudgeOutputFormatError extends Error {
  override readonly name = "JudgeOutputFormatError";
  constructor(message: string) {
    super(message);
  }
}

export interface JudgeRequest {
  prompt: string;
  response: string;
  criterion: RubricCriterion;
  systemMessage?: string;
}

export interface JudgeOptions {
  signal?: AbortSignal;
}

export interface JudgeResponse {
  result: JudgeResult;
  cost: JudgeCost;
  cached: boolean;
}

export interface JudgeClient {
  judge(request: JudgeRequest, options?: JudgeOptions): Promise<JudgeResponse>;
  estimateCost?(
    request: JudgeRequest,
    options?: { completionTokens?: number },
  ): number | undefined;
  /**
   * Optional stable identity string for cache keying. Implementations should
   * return a deterministic value derived from any configuration that affects
   * judge output (e.g., model name, temperature, response_format, max tokens).
   * Two clients that return the same `cacheIdentity()` are considered
   * cache-compatible. Two clients that differ in any output-affecting
   * configuration MUST return different values to avoid cache poisoning.
   */
  cacheIdentity?(): string;
  dispose?(): Promise<void>;
}

export interface JudgeCache {
  get(key: string): Promise<JudgeResponse | undefined>;
  set(key: string, value: JudgeResponse): Promise<void>;
}

export type { Rubric, RubricCriterion, JudgeResult, JudgeCost };
