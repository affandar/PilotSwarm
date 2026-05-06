/**
 * Centralized Zod numeric refinement helpers.
 *
 * These helpers replace the inline `.finite().int().nonnegative().refine(-0)`
 * chains scattered through `types.ts`. Each helper enforces a uniform numeric
 * contract that downstream code (CIGate, regression detector, baseline,
 * matrix runner, reporters) can rely on without re-validating.
 *
 * Hardening rules enforced (iter18):
 *   - All nonnegative integer counts MUST be `Number.isSafeInteger`. This
 *     blocks `2 ** 53` and similar values that round to `2 ** 53` and break
 *     identity arithmetic downstream.
 *   - Negative zero is rejected on every count and rate field. JSON
 *     round-trips collapse `-0` to `0` but `Object.is(-0, 0) === false`,
 *     which breaks invariant checks that depend on `===` equality.
 *   - All rates are finite, in `[0, 1]`, and reject `-0` and `NaN`.
 *   - All p-values are finite, in `[0, 1]`, and reject `-0` and `NaN`.
 *   - Cost values are finite, nonnegative, reject `-0`, but unbounded above
 *     so legitimate large costs (e.g. $1000) are accepted.
 *   - `nonblankString` rejects whitespace-only strings AFTER trimming. This
 *     should ONLY be applied to identifier fields (e.g. `MatrixConfig.id`),
 *     never to free-form description / case-id fields where whitespace may
 *     be intentional.
 */
import { z } from "zod";

const NEGATIVE_ZERO_MESSAGE = "negative zero is not a valid value";

function rejectNegativeZero<T extends z.ZodTypeAny>(schema: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return schema.refine((n: number) => !Object.is(n, -0), {
    message: NEGATIVE_ZERO_MESSAGE,
  }) as unknown as T;
}

/**
 * Nonnegative count field: 0..Number.MAX_SAFE_INTEGER, integer, no -0.
 *
 * Use for: trials, passCount, failCount, errorCount, total, passed, failed,
 * errored, infraErrorCount, n, schemaVersion-like nonneg ints.
 */
export function safeIntCount() {
  return rejectNegativeZero(
    z
      .number()
      .int()
      .nonnegative()
      .refine((n) => Number.isSafeInteger(n), {
        message: "value must be a safe integer (<= 2^53 - 1)",
      }),
  );
}

/**
 * Strictly positive integer: 1..Number.MAX_SAFE_INTEGER.
 *
 * Use for: passAtKValues entries, k.
 */
export function safePosInt() {
  return rejectNegativeZero(
    z
      .number()
      .int()
      .positive()
      .refine((n) => Number.isSafeInteger(n), {
        message: "value must be a safe integer (<= 2^53 - 1)",
      }),
  );
}

/**
 * Strictly positive integer cap: 1..Number.MAX_SAFE_INTEGER.
 *
 * Use for: trials caps, maxCells caps where 0 makes no semantic sense.
 */
export function safeIntCap() {
  return safePosInt();
}

/**
 * Pass-rate / proportion in `[0, 1]`. Finite, no -0, no NaN.
 *
 * Use for: passRate, meanPassRate, point, lower, upper, MatrixPassRateRef.passRate.
 */
export function finiteRate() {
  return rejectNegativeZero(z.number().finite().min(0).max(1));
}

/**
 * Cost in USD: finite nonnegative, no -0. Unbounded above.
 *
 * Use for: maxCostUsd, totalCostUsd, estimatedCostUsd, budgetUsd.
 */
export function finiteCost() {
  return rejectNegativeZero(z.number().finite().nonnegative());
}

/**
 * Generic finite nonnegative number with `-0` rejection. Used for
 * timestamp/latency/duration fields (milliseconds), token counts that
 * are tracked as numbers rather than ints, and any other finite
 * nonnegative quantity that is not a count, rate, cost, or p-value.
 */
export function finiteNonNegative() {
  return rejectNegativeZero(z.number().finite().nonnegative());
}

/**
 * P-value in `[0, 1]`. Finite, no -0, no NaN.
 *
 * Use for: pValue, adjustedPValue, alpha.
 */
export function finitePValue() {
  return rejectNegativeZero(z.number().finite().min(0).max(1));
}

/**
 * String identifier that must contain at least one non-whitespace character
 * after trimming. Apply ONLY to strict identifier fields (e.g.
 * `MatrixConfig.id`, `Score.name`). Do NOT apply to free-form
 * description / caseId fields where whitespace may be intentional.
 */
export function nonblankString() {
  return z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, {
      message: "value must contain at least one non-whitespace character",
    });
}
