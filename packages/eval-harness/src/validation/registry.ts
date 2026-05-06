/**
 * Strict schema registry — central self-policing for Family 1.
 *
 * Every public `*Schema` exported from `src/types.ts` MUST be registered
 * here with a known-valid fixture. `assertRegistryComplete()` walks every
 * enumerable own property of the `types` namespace and ensures no
 * `*Schema` is omitted (carve-outs explicit).
 *
 * Why: in iter17 several public schemas were silently missing from the
 * Family 1 matrix (e.g. `RunResultSchema`, `MatrixResultSchema`,
 * `TrajectoryRunResultSchema`). A fixer dropping `.strict()` on those
 * schemas would have passed the test suite. The registry now self-polices
 * — adding a new public schema without adding it here will fail loudly.
 */
import { z } from "zod";
import * as types from "../types.js";

export interface RegistryEntry {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  valid: any;
}

/**
 * Documented carve-outs: schemas that are intentionally NOT in the strict
 * registry. Each entry must have a documented reason in
 * `docs/INVARIANT-COVERAGE.md` "Documented carve-outs" section.
 */
export const REGISTRY_CARVE_OUTS: ReadonlySet<string> = new Set([
  "DurabilityExpectedSchema",
]);

/**
 * Known-valid fixtures for every strict schema. Used both for round-trip
 * tests (Family 1 valid-fixture) and for unknown-key rejection tests
 * (Family 1 strictness).
 */
export const STRICT_SCHEMA_REGISTRY: ReadonlyArray<RegistryEntry> = [
  {
    name: "EvalToolCallSchema",
    schema: types.EvalToolCallSchema,
    valid: { name: "t", match: "subset" },
  },
  {
    name: "EvalExpectedSchema",
    schema: types.EvalExpectedSchema,
    valid: { toolCalls: [{ name: "t", match: "subset" }] },
  },
  {
    name: "EvalContextMessageSchema",
    schema: types.EvalContextMessageSchema,
    valid: { role: "user", content: "hi" },
  },
  {
    name: "EvalSampleInputSchema",
    schema: types.EvalSampleInputSchema,
    valid: { prompt: "p" },
  },
  {
    name: "EvalSampleSchema",
    schema: types.EvalSampleSchema,
    valid: {
      id: "s",
      description: "d",
      input: { prompt: "p" },
      expected: { toolCalls: [{ name: "t" }] },
    },
  },
  {
    name: "EvalTaskSchema",
    schema: types.EvalTaskSchema,
    valid: {
      schemaVersion: 1,
      id: "t",
      name: "n",
      description: "d",
      version: "1",
      samples: [
        {
          id: "s",
          description: "d",
          input: { prompt: "p" },
          expected: { toolCalls: [{ name: "t" }] },
        },
      ],
    },
  },
  {
    name: "ScoreSchema",
    schema: types.ScoreSchema,
    valid: { name: "s", value: 1, pass: true, reason: "r" },
  },
  {
    name: "CaseResultSchema",
    schema: types.CaseResultSchema,
    valid: {
      caseId: "c",
      pass: true,
      scores: [],
      observed: { toolCalls: [], finalResponse: "", sessionId: "s", latencyMs: 0 },
      durationMs: 0,
    },
  },
  {
    name: "RunSummarySchema",
    schema: types.RunSummarySchema,
    valid: { total: 0, passed: 0, failed: 0, errored: 0 },
  },
  {
    name: "RunResultSchema",
    schema: types.RunResultSchema,
    valid: {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      summary: { total: 0, passed: 0, failed: 0, errored: 0, noQualitySignal: true },
      cases: [],
    },
  },
  {
    name: "WilsonCISchema",
    schema: types.WilsonCISchema,
    valid: { lower: 0, upper: 0, point: 0, z: 1.96 },
  },
  {
    name: "TrialScoreAggregateSchema",
    schema: types.TrialScoreAggregateSchema,
    valid: { mean: 0, stddev: 0, n: 0, values: [] },
  },
  {
    name: "SampleTrialResultSchema",
    schema: types.SampleTrialResultSchema,
    valid: {
      sampleId: "s",
      trials: 0,
      passCount: 0,
      failCount: 0,
      errorCount: 0,
      noQualitySignal: true,
      passAtK: {},
      scores: {},
      wilsonCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
    },
  },
  {
    name: "MultiTrialSummarySchema",
    schema: types.MultiTrialSummarySchema,
    valid: {
      total: 0,
      trials: 0,
      stddevPassRate: 0,
      passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
    },
  },
  {
    name: "MultiTrialResultBaseSchema",
    schema: types.MultiTrialResultBaseSchema,
    valid: {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 0,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 0,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [],
      rawRuns: [],
    },
  },
  {
    name: "MultiTrialResultSchema",
    schema: types.MultiTrialResultSchema,
    valid: {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 0,
      startedAt: "a",
      finishedAt: "b",
      summary: {
        total: 0,
        trials: 0,
        stddevPassRate: 0,
        passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
      },
      samples: [],
      rawRuns: [],
    },
  },
  {
    name: "MatrixConfigOverridesSchema",
    schema: types.MatrixConfigOverridesSchema,
    valid: {},
  },
  {
    name: "MatrixConfigSchema",
    schema: types.MatrixConfigSchema,
    valid: { id: "c", label: "l", overrides: {} },
  },
  {
    name: "MatrixCellSchema",
    schema: types.MatrixCellSchema,
    valid: {
      model: "m",
      configId: "c",
      configLabel: "l",
      result: {
        schemaVersion: 1,
        runId: "r",
        taskId: "t",
        taskVersion: "1",
        model: "m",
        trials: 0,
        startedAt: "a",
        finishedAt: "b",
        summary: {
          total: 0,
          trials: 0,
          stddevPassRate: 0,
          passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
        },
        samples: [],
        rawRuns: [],
      },
    },
  },
  {
    name: "MatrixPassRateRefSchema",
    schema: types.MatrixPassRateRefSchema,
    valid: { model: "m", configId: "c", passRate: 0 },
  },
  {
    name: "MatrixSummarySchema",
    schema: types.MatrixSummarySchema,
    valid: {
      totalCells: 0,
      bestPassRate: { model: "m", configId: "c", passRate: 0 },
      worstPassRate: { model: "m", configId: "c", passRate: 0 },
    },
  },
  {
    name: "MatrixResultSchema",
    schema: types.MatrixResultSchema,
    valid: {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      models: ["m"],
      configs: [{ id: "c", label: "l", overrides: {} }],
      cells: [
        {
          model: "m",
          configId: "c",
          configLabel: "l",
          result: {
            schemaVersion: 1,
            runId: "r",
            taskId: "t",
            taskVersion: "1",
            model: "m",
            trials: 0,
            startedAt: "a",
            finishedAt: "b",
            summary: {
              total: 0,
              trials: 0,
              stddevPassRate: 0,
              passRateCI: { lower: 0, upper: 0, point: 0, z: 1.96 },
            },
            samples: [],
            rawRuns: [],
          },
        },
      ],
      summary: {
        totalCells: 1,
        bestPassRate: { model: "m", configId: "c", passRate: 0 },
        worstPassRate: { model: "m", configId: "c", passRate: 0 },
      },
    },
  },
  {
    name: "MissingScorePolicySchema",
    schema: types.MissingScorePolicySchema,
    valid: "exclude",
  },
  {
    name: "DurabilityFaultPointSchema",
    schema: types.DurabilityFaultPointSchema,
    valid: "before_turn",
  },
  {
    name: "DurabilityFaultModeSchema",
    schema: types.DurabilityFaultModeSchema,
    valid: "worker_crash",
  },
  {
    name: "TurnExpectedSchema",
    schema: types.TurnExpectedSchema,
    valid: { toolCalls: [{ name: "t" }] },
  },
  {
    name: "TurnInputSchema",
    schema: types.TurnInputSchema,
    valid: { prompt: "p" },
  },
  {
    name: "TrajectoryTurnSchema",
    schema: types.TrajectoryTurnSchema,
    valid: { input: { prompt: "p" }, expected: { toolCalls: [{ name: "t" }] } },
  },
  {
    name: "TrajectorySampleSchema",
    schema: types.TrajectorySampleSchema,
    valid: {
      id: "s",
      description: "d",
      turns: [
        { input: { prompt: "p" }, expected: { toolCalls: [{ name: "t" }] } },
      ],
    },
  },
  {
    name: "TrajectoryTaskSchema",
    schema: types.TrajectoryTaskSchema,
    valid: {
      schemaVersion: 1,
      id: "t",
      name: "n",
      description: "d",
      version: "1",
      samples: [
        {
          id: "s",
          description: "d",
          turns: [
            { input: { prompt: "p" }, expected: { toolCalls: [{ name: "t" }] } },
          ],
        },
      ],
    },
  },
  {
    name: "TrajectoryScoreSchema",
    schema: types.TrajectoryScoreSchema,
    valid: { turnScores: [], crossTurnScores: [], holisticScores: [] },
  },
  {
    name: "TrajectoryCaseResultSchema",
    schema: types.TrajectoryCaseResultSchema,
    valid: {
      caseId: "c",
      pass: true,
      trajectoryScore: {
        turnScores: [],
        crossTurnScores: [],
        holisticScores: [],
      },
      observed: { turns: [], sessionId: "s", totalLatencyMs: 0 },
      durationMs: 0,
    },
  },
  {
    name: "TrajectoryRunResultSchema",
    schema: types.TrajectoryRunResultSchema,
    valid: {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      summary: { total: 0, passed: 0, failed: 0, errored: 0, noQualitySignal: true },
      cases: [],
    },
  },
  {
    name: "RubricCriterionSchema",
    schema: types.RubricCriterionSchema,
    valid: {
      id: "c",
      description: "d",
      scale: { min: 0, max: 1 },
      passThreshold: 0.5,
    },
  },
  {
    name: "RubricSchema",
    schema: types.RubricSchema,
    valid: {
      id: "r",
      name: "Rubric",
      version: "1",
      criteria: [
        { id: "c", description: "d", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
      ],
    },
  },
  {
    name: "JudgeResultSchema",
    schema: types.JudgeResultSchema,
    valid: {
      criterionId: "c",
      reasoning: "ok",
      rawScore: 0,
      normalizedScore: 0,
      pass: true,
    },
  },
  {
    name: "JudgeCostSchema",
    schema: types.JudgeCostSchema,
    valid: { inputTokens: 0, outputTokens: 0, model: "m" },
  },
  {
    name: "CIGateConfigSchema",
    schema: types.CIGateConfigSchema,
    valid: {},
  },
  {
    name: "CIGateResultSchema",
    schema: types.CIGateResultSchema,
    valid: { pass: true, reasons: [] },
  },
  {
    name: "RegressionResultSchema",
    schema: types.RegressionResultSchema,
    valid: {
      sampleId: "s",
      baselinePassRate: 0,
      currentPassRate: 0,
      pValue: 0,
      significant: false,
      direction: "unchanged",
    },
  },
  {
    name: "RegressionDetectionResultSchema",
    schema: types.RegressionDetectionResultSchema,
    valid: {
      regressions: [],
      missingBaselineSamples: [],
      newCurrentSamples: [],
    },
  },
  {
    name: "BaselineSampleSchema",
    schema: types.BaselineSampleSchema,
    valid: { sampleId: "s", passRate: 0, trials: 0, passCount: 0 },
  },
  {
    name: "BaselineSchema",
    schema: types.BaselineSchema,
    valid: {
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [{ sampleId: "s", passRate: 0, trials: 0, passCount: 0 }],
    },
  },
  {
    name: "BaselineSchemaAllowEmpty",
    schema: types.BaselineSchemaAllowEmpty,
    valid: {
      schemaVersion: 1,
      taskId: "t",
      taskVersion: "1",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [],
    },
  },
  {
    // G9: a single persisted CMS session event captured by LiveDriver via
    // `session.getMessages()`. Strict because we explicitly map fields from
    // the SDK shape into this canonical form — no SDK passthrough is allowed.
    // Lives in `ObservedResult.cmsEvents` (the parent is lenient).
    name: "CmsObservedEventSchema",
    schema: types.CmsObservedEventSchema,
    valid: {
      seq: 0,
      eventType: "user.message",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
];

const REGISTRY_NAMES: ReadonlySet<string> = new Set(
  STRICT_SCHEMA_REGISTRY.map((e) => e.name),
);

/**
 * Lenient input boundary registry — PilotSwarm/driver/SDK observation schemas
 * that are intentionally `.passthrough()` so forward-compatible fields do not
 * become infra outages. These schemas:
 *   1. ACCEPT extra keys (and preserve them in the parsed output);
 *   2. Are normalized into a canonical strict shape by
 *      `src/validation/normalize-result.ts` before scoring/grading.
 *
 * The names below MUST match the lenient export from `src/types.ts`.
 */
export const LENIENT_INPUT_SCHEMA_REGISTRY: ReadonlyArray<RegistryEntry> = [
  {
    name: "ObservedToolCallSchema",
    schema: types.ObservedToolCallSchema,
    valid: { name: "t", args: {}, order: 0 },
  },
  {
    name: "ObservedResultSchema",
    schema: types.ObservedResultSchema,
    valid: { toolCalls: [], finalResponse: "", sessionId: "s", latencyMs: 0 },
  },
  {
    name: "ObservedTurnSchema",
    schema: types.ObservedTurnSchema,
    valid: { toolCalls: [], response: "", latencyMs: 0 },
  },
  {
    name: "ObservedTrajectorySchema",
    schema: types.ObservedTrajectorySchema,
    valid: { turns: [], sessionId: "s", totalLatencyMs: 0 },
  },
  {
    name: "DurabilityObservationSchema",
    schema: types.DurabilityObservationSchema,
    valid: {
      scenario: "s",
      faultPoint: "before_turn",
      faultMode: "worker_crash",
      injected: false,
      recovered: false,
      toolCallsBeforeFault: 0,
      toolCallsAfterRecovery: 0,
    },
  },
];

const LENIENT_NAMES: ReadonlySet<string> = new Set(
  LENIENT_INPUT_SCHEMA_REGISTRY.map((e) => e.name),
);

/**
 * Strict artifact-only registry — derived view of `STRICT_SCHEMA_REGISTRY`
 * with lenient-input names filtered out. Use this for "harness-owned strict
 * artifact" assertions. Lenient inputs (Observed*, Durability) live in
 * `LENIENT_INPUT_SCHEMA_REGISTRY` and must NOT be in this view.
 */
export const STRICT_ARTIFACT_SCHEMA_REGISTRY: ReadonlyArray<RegistryEntry> =
  STRICT_SCHEMA_REGISTRY.filter((e) => !LENIENT_NAMES.has(e.name));

/**
 * Walks `import * as types from "../types.js"` and asserts that every
 * exported `*Schema` is either in `STRICT_SCHEMA_REGISTRY`,
 * `LENIENT_INPUT_SCHEMA_REGISTRY`, or in `REGISTRY_CARVE_OUTS`.
 * Throws with the offending name(s) on mismatch.
 *
 * Use as the first test in `Family 1` so a fixer that adds a new public
 * schema without registering it fails loudly.
 */
export function assertRegistryComplete(): void {
  const exported: string[] = [];
  for (const key of Object.keys(types)) {
    const value = (types as Record<string, unknown>)[key];
    // Detect any Zod schema by `safeParse` presence — this catches both
    // `*Schema` and adjunct names like `BaselineSchemaAllowEmpty`.
    if (value && typeof value === "object" && "safeParse" in (value as object)) {
      exported.push(key);
    }
  }
  const missing: string[] = [];
  for (const name of exported) {
    if (REGISTRY_NAMES.has(name)) continue;
    if (LENIENT_NAMES.has(name)) continue;
    if (REGISTRY_CARVE_OUTS.has(name)) continue;
    missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(
      `Schema registry is missing entries for: ${missing.join(", ")}. ` +
        `Add them to STRICT_SCHEMA_REGISTRY or LENIENT_INPUT_SCHEMA_REGISTRY in ` +
        `src/validation/registry.ts, or document a carve-out in ` +
        `REGISTRY_CARVE_OUTS + docs/INVARIANT-COVERAGE.md.`,
    );
  }
  // Reverse check: any registry entry that isn't actually exported anymore
  // indicates a stale registration.
  const stale: string[] = [];
  for (const e of STRICT_SCHEMA_REGISTRY) {
    if (!exported.includes(e.name) && !REGISTRY_CARVE_OUTS.has(e.name)) {
      stale.push(`STRICT:${e.name}`);
    }
  }
  for (const e of LENIENT_INPUT_SCHEMA_REGISTRY) {
    if (!exported.includes(e.name) && !REGISTRY_CARVE_OUTS.has(e.name)) {
      stale.push(`LENIENT:${e.name}`);
    }
  }
  // Any name listed in BOTH registries is a registration bug.
  for (const name of LENIENT_NAMES) {
    if (REGISTRY_NAMES.has(name)) {
      stale.push(`DUPLICATE:${name} appears in both strict and lenient registries`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Schema registry has stale or duplicate entries: ${stale.join(", ")}.`,
    );
  }
}
