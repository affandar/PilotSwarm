/**
 * Per-stage normalizers — single source of truth for boundary validation.
 *
 * Each `normalize*` function is the ONE place where its respective stage
 * validates inbound data via `parseAtBoundary`. Boundaries:
 *
 *   - `normalizeObservedResult`     — driver → runner (untrusted)
 *   - `normalizeRunResult`          — runner → caller / multi-trial
 *   - `normalizeMultiTrialResult`   — multi-trial → matrix / regression / CI
 *   - `normalizeMatrixConfig`       — caller → MatrixRunner constructor
 *   - `normalizeMatrixResult`       — MatrixRunner → caller
 *   - `normalizeBaseline`           — disk / wire → regression / CI
 *
 * Why centralize: in iter17 each runner re-implemented its own ad-hoc
 * validation (some used `safeParse`, some used `parse`, some did neither).
 * iter18 collapses them into a uniform contract:
 *
 *   1. Driver-output validation returns an `infraScore` Score (so the
 *      runner can record an infra outage rather than fail-closed).
 *   2. ALL OTHER stages throw structured `Error`s on failure. These
 *      represent "the eval-harness internals produced corrupt data",
 *      which is a programmer/integrity bug — not a model-quality fail —
 *      and must surface loudly.
 */
import {
  ObservedResultSchema,
  RunResultSchema,
  MultiTrialResultBaseSchema,
  MatrixConfigSchema,
  MatrixResultSchema,
  BaselineSchema,
  BaselineSchemaAllowEmpty,
  type ObservedResult,
  type RunResult,
  type MultiTrialResult,
  type MatrixConfig,
  type MatrixResult,
  type Baseline,
  type Score,
} from "../types.js";
import { parseAtBoundary, parseAtBoundaryOrInfraError } from "./trust-boundary.js";

/**
 * Driver-output normalizer. The driver is untrusted: a buggy or hostile
 * driver can return non-conforming data. On failure we return an
 * `infraScore` so the runner records an infra outage (excluded from
 * passRate) instead of fail-closing the entire run.
 *
 * The inbound `ObservedResultSchema` is `.passthrough()` so forward-compatible
 * PilotSwarm/SDK fields (e.g. `id`, `callId`, `usage`, `events`, `provider`)
 * do not become an infra outage. After lenient parse, we PROJECT to a
 * canonical strict shape so downstream scorers/graders see only known fields.
 */
export function normalizeObservedResult(
  value: unknown,
): { ok: true; data: ObservedResult } | { ok: false; infraScore: Score } {
  const result = parseAtBoundaryOrInfraError(ObservedResultSchema, value, {
    context: "driver:ObservedResult",
    scoreName: "driver-output-shape",
  });
  if (result.ok) {
    return { ok: true, data: Object.freeze(projectObservedResult(result.data)) };
  }
  // result is { ok: false; infraScore } — narrow back.
  if ("infraScore" in result) return { ok: false, infraScore: result.infraScore };
  // Should not happen; defend in depth.
  return {
    ok: false,
    infraScore: {
      name: "driver-output-shape",
      value: 0,
      pass: false,
      reason: "normalizeObservedResult: unknown failure",
      infraError: true,
    },
  };
}

/**
 * Project a leniently-parsed `ObservedResult` to its canonical strict shape:
 * only known fields, with each tool call also projected. Guarantees scorers
 * never see forward-compatible passthrough metadata.
 */
function projectObservedResult(parsed: ObservedResult): ObservedResult {
  const out: ObservedResult = {
    toolCalls: parsed.toolCalls.map(projectObservedToolCall),
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    latencyMs: parsed.latencyMs,
  };
  if (parsed.model !== undefined) out.model = parsed.model;
  if (parsed.cmsState !== undefined) out.cmsState = parsed.cmsState;
  if (parsed.durability !== undefined) out.durability = parsed.durability;
  // G9: preserve `cmsEvents` through projection. The lenient passthrough
  // parse accepts arbitrary extras, but `projectObservedResult` strips
  // anything not explicitly copied here. Drivers that capture CMS events
  // (LiveDriver via `session.getMessages()`) need this projection slot so
  // graders / durability tests can assert on real system-tool evidence
  // and worker-handoff via `workerNodeId` fields.
  if (parsed.cmsEvents !== undefined) out.cmsEvents = parsed.cmsEvents;
  return out;
}

function projectObservedToolCall(
  call: ObservedResult["toolCalls"][number],
): ObservedResult["toolCalls"][number] {
  const out: ObservedResult["toolCalls"][number] = {
    name: call.name,
    args: call.args,
    order: call.order,
  };
  if (call.result !== undefined) out.result = call.result;
  if (call.timestamp !== undefined) out.timestamp = call.timestamp;
  return out;
}

function throwOnFailure<T>(
  schema: Parameters<typeof parseAtBoundary<T>>[0],
  value: unknown,
  context: string,
): T {
  const r = parseAtBoundary(schema, value, { context });
  if (r.ok) return r.data;
  throw new Error(`${context} failed schema validation: ${r.error}`);
}

/** Runner-output normalizer. Throws on shape violations. */
export function normalizeRunResult(value: unknown): RunResult {
  return throwOnFailure(RunResultSchema, value, "normalizeRunResult");
}

/**
 * Multi-trial normalizer. Uses the STRUCTURAL base schema (no semantic
 * `meanPassRate` cross-check) so the caller can decide whether to trust
 * summary or recompute (see CIGate.trustSummary). Throws on shape violations.
 */
export function normalizeMultiTrialResult(value: unknown): MultiTrialResult {
  return throwOnFailure(
    MultiTrialResultBaseSchema,
    value,
    "normalizeMultiTrialResult",
  );
}

/** MatrixConfig normalizer. Throws on shape violations. */
export function normalizeMatrixConfig(value: unknown): MatrixConfig {
  return throwOnFailure(MatrixConfigSchema, value, "normalizeMatrixConfig");
}

/** MatrixResult normalizer. Throws on shape violations. */
export function normalizeMatrixResult(value: unknown): MatrixResult {
  return throwOnFailure(MatrixResultSchema, value, "normalizeMatrixResult");
}

/**
 * Baseline normalizer. `allowEmpty` mirrors the strict/lenient split in
 * `BaselineSchema` vs `BaselineSchemaAllowEmpty`. Throws on shape violations.
 */
export function normalizeBaseline(
  value: unknown,
  opts: { allowEmpty?: boolean } = {},
): Baseline {
  const schema = opts.allowEmpty ? BaselineSchemaAllowEmpty : BaselineSchema;
  return throwOnFailure(schema, value, "normalizeBaseline");
}
