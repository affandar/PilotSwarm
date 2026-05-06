import { z } from "zod";
import {
  finiteCost,
  finiteNonNegative,
  finitePValue,
  finiteRate,
  nonblankString,
  safeIntCap,
  safeIntCount,
  safePosInt,
} from "./validation/numbers.js";
import { wilsonInterval } from "./stats.js";

/**
 * Legacy local helper kept for backward compatibility with code that imports
 * from this file's internals; prefer `safeIntCount` from
 * `./validation/numbers.js` for new code. iter19: this now delegates to the
 * central helper so the safe-integer upper bound is uniformly enforced.
 */
function nonNegativeIntCount() {
  return safeIntCount();
}

function duplicateIds<T>(
  values: T[],
  getId: (value: T) => string,
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const id = getId(value);
    if (seen.has(id)) {
      duplicates.add(id);
    } else {
      seen.add(id);
    }
  }
  return [...duplicates];
}

export const EvalToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  match: z.enum(["exact", "subset", "fuzzy", "setEquals"]).default("subset"),
  subsetCaseInsensitive: z.boolean().optional(),
  numericTolerance: finiteNonNegative().optional(),
  fuzzyStringMaxRelativeDistance: finiteNonNegative().optional(),
  order: z.number().int().refine((n) => Number.isSafeInteger(n), { message: "value must be a safe integer" }).optional(),
}).strict();
export type EvalToolCall = z.infer<typeof EvalToolCallSchema>;

export const EvalExpectedSchema = z
  .object({
    toolCalls: z.array(EvalToolCallSchema).optional(),
    toolSequence: z.enum(["strict", "subsequence", "exactSequence", "unordered"]).default("unordered"),
    forbiddenTools: z.array(z.string().min(1)).optional(),
    minCalls: safeIntCount().optional(),
    maxCalls: safeIntCount().optional(),
    noToolCall: z.boolean().optional(),
    response: z
      .object({
        containsAny: z.array(z.string()).min(1).optional(),
        containsAll: z.array(z.string()).min(1).optional(),
      })
      .strict()
      .optional(),
    cms: z
      .object({
        stateIn: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    durability: z.lazy(() => DurabilityExpectedSchema).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.noToolCall === true && val.toolCalls && val.toolCalls.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noToolCall=true cannot be combined with non-empty toolCalls",
        path: ["noToolCall"],
      });
    }
    if (
      typeof val.minCalls === "number" &&
      typeof val.maxCalls === "number" &&
      val.minCalls > val.maxCalls
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `minCalls (${val.minCalls}) must be <= maxCalls (${val.maxCalls})`,
        path: ["minCalls"],
      });
    }
  });
export type EvalExpected = z.infer<typeof EvalExpectedSchema>;

export function hasEvalExpectedCriteria(expected: EvalExpected): boolean {
  return (
    (expected.toolCalls?.length ?? 0) > 0 ||
    (expected.forbiddenTools?.length ?? 0) > 0 ||
    typeof expected.minCalls === "number" ||
    typeof expected.maxCalls === "number" ||
    expected.noToolCall === true ||
    (expected.response?.containsAny?.length ?? 0) > 0 ||
    (expected.response?.containsAll?.length ?? 0) > 0 ||
    (expected.cms?.stateIn?.length ?? 0) > 0 ||
    expected.durability !== undefined
  );
}

export const EvalContextMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
}).strict();

export const EvalSampleInputSchema = z.object({
  prompt: z.string(),
  systemMessage: z.string().optional(),
  context: z.array(EvalContextMessageSchema).optional(),
}).strict();

export const EvalSampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  input: EvalSampleInputSchema,
  expected: EvalExpectedSchema,
  tools: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: safePosInt().default(120000),
}).strict().superRefine((val, ctx) => {
  const expected = val.expected;
  if (!hasEvalExpectedCriteria(expected)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `sample "${val.id}" has no expected criteria`,
      path: ["expected"],
    });
  }
});
export type EvalSample = z.infer<typeof EvalSampleSchema>;

export const EvalTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    runnable: z.boolean().default(true),
    passRateFloor: finiteRate().refine((n) => n > 0, { message: "passRateFloor must be > 0" }).optional(),
    samples: z.array(EvalSampleSchema).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const duplicates = duplicateIds(val.samples, (sample) => sample.id);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate sample IDs in EvalTask: ${duplicates.join(", ")}`,
        path: ["samples"],
      });
    }
  });
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/**
 * Individual grader score.
 *
 * Invariant: when `infraError === true`, `pass` MUST be `false`. Direct
 * consumers should check `infraError` before treating `pass` as a quality
 * signal. The schema enforces this so hand-constructed Score objects can't
 * silently flip a quality pass on top of an infra failure.
 */
export const ScoreSchema = z
  .object({
    name: z.string(),
    value: finiteRate(),
    pass: z.boolean(),
    reason: z.string(),
    actual: z.unknown().optional(),
    expected: z.unknown().optional(),
    infraError: z.boolean().optional(),
    infraSource: z.enum(["grader", "driver", "judge"]).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.infraError === true && val.pass === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "infraError=true requires pass=false (infra errors are not quality passes)",
        path: ["pass"],
      });
    }
    if (val.infraError === true && val.value !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "infraError=true requires value=0 (infra errors are not quality signals)",
        path: ["value"],
      });
    }
  });
/**
 * Individual grader score. When `infraError: true`, `pass` MUST be `false`;
 * direct consumers should check `infraError` before treating `pass` as a
 * quality signal.
 */
export type Score = z.infer<typeof ScoreSchema>;

// PilotSwarm-input boundary schemas: lenient (.passthrough()) so forward-
// compatible PilotSwarm/SDK metadata (id, type, callId, raw, usage, events,
// requestId, provider…) does not become an infra-error outage. Extra fields
// are stripped by `normalizeObservedResult` before scoring (see
// src/validation/normalize-result.ts).
export const ObservedToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  timestamp: finiteNonNegative().optional(),
  order: safeIntCount(),
}).passthrough();
export type ObservedToolCall = z.infer<typeof ObservedToolCallSchema>;

/**
 * G9: a single persisted CMS session event. Mirrors the SDK's `SessionEvent`
 * shape but kept independent so eval-harness types stay decoupled from SDK
 * internals. The `data` field is intentionally `unknown` to match the SDK
 * contract; downstream graders narrow it via inspection.
 *
 * `workerNodeId` is included so durability tests can detect a real worker
 * handoff by observing different worker IDs across consecutive events for
 * the same session.
 */
export const CmsObservedEventSchema = z.object({
  seq: safeIntCount(),
  eventType: z.string(),
  data: z.unknown().optional(),
  createdAt: z.string(),
  workerNodeId: z.string().optional(),
}).strict();
export type CmsObservedEvent = z.infer<typeof CmsObservedEventSchema>;

export const ObservedResultSchema = z.object({
  toolCalls: z.array(ObservedToolCallSchema),
  finalResponse: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
  latencyMs: finiteNonNegative(),
  cmsState: z.string().optional(),
  durability: z.lazy(() => DurabilityObservationSchema).optional(),
  /**
   * G9: full ordered list of persisted CMS events for this session.
   *
   * Captured by drivers that have access to a real CMS (e.g. LiveDriver via
   * `session.getMessages()`). Allows graders / durability tests to assert
   * on REAL system-tool evidence (e.g. "did `spawn_agent` actually fire and
   * persist?") rather than just trusting the LLM's self-reported tool-calls
   * list. Also surfaces `workerNodeId` per event, which is the canonical
   * signal for cross-worker handoff verification.
   *
   * Optional because synthetic / fake drivers don't have a CMS to query.
   * Drivers that fail to capture events (e.g. session deleted before
   * read) leave this undefined — callers should treat `undefined` as
   * "unknown / not captured" rather than "no events occurred".
   */
  cmsEvents: z.array(CmsObservedEventSchema).optional(),
}).passthrough();
export type ObservedResult = z.infer<typeof ObservedResultSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  pass: z.boolean(),
  scores: z.array(ScoreSchema),
  observed: ObservedResultSchema,
  infraError: z.string().optional(),
  durationMs: finiteNonNegative(),
}).strict();
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const RunSummarySchema = z.object({
  total: safeIntCount(),
  passed: safeIntCount(),
  failed: safeIntCount(),
  errored: safeIntCount(),
  passRate: finiteRate().optional(),
  noQualitySignal: z.boolean().optional(),
  infraErrorRate: finiteRate().optional(),
}).strict();

export const RunResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: RunSummarySchema,
  cases: z.array(CaseResultSchema),
}).strict().superRefine((val, ctx) => {
  const PASSRATE_EPSILON = 1e-9;
  const { summary, cases } = val;
  // H3 (iter19): duplicate caseId rejection.
  const dupes = duplicateIds(cases, (c) => c.caseId);
  if (dupes.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate caseId in RunResult.cases: ${dupes.join(", ")}`,
      path: ["cases"],
    });
  }
  if (summary.total !== cases.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.total (${summary.total}) must equal cases.length (${cases.length})`,
      path: ["summary", "total"],
    });
  }
  if (summary.passed + summary.failed + summary.errored !== summary.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.passed + summary.failed + summary.errored (${summary.passed + summary.failed + summary.errored}) must equal summary.total (${summary.total})`,
      path: ["summary", "total"],
    });
  }
  const passedActual = cases.filter((c) => c.pass === true).length;
  const erroredActual = cases.filter((c) => c.infraError !== undefined).length;
  const failedActual = cases.filter((c) => c.pass === false && c.infraError === undefined).length;
  if (summary.passed !== passedActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.passed (${summary.passed}) does not match cases.filter(c=>c.pass).length (${passedActual})`,
      path: ["summary", "passed"],
    });
  }
  if (summary.failed !== failedActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.failed (${summary.failed}) does not match cases.filter(c=>!c.pass && !c.infraError).length (${failedActual})`,
      path: ["summary", "failed"],
    });
  }
  if (summary.errored !== erroredActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.errored (${summary.errored}) does not match cases.filter(c=>c.infraError).length (${erroredActual})`,
      path: ["summary", "errored"],
    });
  }
  const denom = summary.passed + summary.failed;
  if (denom > 0) {
    if (summary.passRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summary.passRate is required when summary.passed + summary.failed > 0",
        path: ["summary", "passRate"],
      });
    } else {
      const expected = summary.passed / denom;
      if (Math.abs(summary.passRate - expected) >= PASSRATE_EPSILON) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `summary.passRate (${summary.passRate}) does not match passed / (passed + failed) = ${expected}`,
          path: ["summary", "passRate"],
        });
      }
    }
  } else if (summary.noQualitySignal !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "summary.noQualitySignal=true is required when passed + failed === 0",
      path: ["summary", "noQualitySignal"],
    });
  }
});
export type RunResult = z.infer<typeof RunResultSchema>;

// ---------------------------------------------------------------------------
// V2: multi-trial and matrix result types
// ---------------------------------------------------------------------------

export const WilsonCISchema = z
  .object({
    lower: finiteRate(),
    upper: finiteRate(),
    point: finiteRate(),
    z: z.number().finite(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.lower > val.upper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `WilsonCI.lower (${val.lower}) must be <= upper (${val.upper})`,
        path: ["lower"],
      });
    }
    if (val.lower > val.point) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `WilsonCI.lower (${val.lower}) must be <= point (${val.point})`,
        path: ["lower"],
      });
    }
    if (val.point > val.upper) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `WilsonCI.point (${val.point}) must be <= upper (${val.upper})`,
        path: ["point"],
      });
    }
  });

export const TrialScoreAggregateSchema = z.object({
  mean: z.number().finite(),
  stddev: z.number().finite().min(0),
  n: safeIntCount(),
  values: z.array(z.number().finite()),
}).strict();

export const SampleTrialResultSchema = z
  .object({
    sampleId: z.string().min(1),
    trials: safeIntCount(),
    passCount: safeIntCount(),
    failCount: safeIntCount(),
    errorCount: safeIntCount(),
    passRate: finiteRate().optional(),
    noQualitySignal: z.boolean().optional(),
    passAtK: z.record(z.coerce.number().int().nonnegative(), finiteRate()),
    scores: z.record(z.string(), TrialScoreAggregateSchema),
    wilsonCI: WilsonCISchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    const PASSRATE_EPSILON = 1e-9;
    const { trials, passCount, failCount, errorCount, passRate, noQualitySignal } = val;
    if (errorCount > trials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `errorCount (${errorCount}) must be <= trials (${trials})`,
        path: ["errorCount"],
      });
    }
    if (passCount + failCount + errorCount !== trials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `passCount + failCount + errorCount (${passCount + failCount + errorCount}) must equal trials (${trials})`,
        path: ["passCount"],
      });
    }
    const denom = trials - errorCount;
    if (denom < 0) {
      // already flagged above; skip further checks
      return;
    }
    if (passCount > denom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `passCount (${passCount}) must be <= trials - errorCount (${denom})`,
        path: ["passCount"],
      });
    }
    if (failCount > denom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failCount (${failCount}) must be <= trials - errorCount (${denom})`,
        path: ["failCount"],
      });
    }
    if (passRate !== undefined) {
      if (denom === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "passRate must be undefined when there is no quality signal (trials - errorCount === 0)",
          path: ["passRate"],
        });
      } else {
        const expected = passCount / denom;
        if (Math.abs(passRate - expected) >= PASSRATE_EPSILON) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `passRate (${passRate}) does not match passCount / (trials - errorCount) = ${expected}`,
            path: ["passRate"],
          });
        }
      }
    } else if (denom > 0 && noQualitySignal !== true) {
      // F9: passRate is required whenever there is a quality signal.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "passRate is required when trials - errorCount > 0 (and noQualitySignal !== true)",
        path: ["passRate"],
      });
    }
    if (noQualitySignal === true && denom !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `noQualitySignal=true requires trials - errorCount === 0 (got ${denom})`,
        path: ["noQualitySignal"],
      });
    }
    if (denom === 0 && noQualitySignal !== true) {
      // F5: when there is no quality signal, the sample MUST declare it.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noQualitySignal=true is required when trials - errorCount === 0",
        path: ["noQualitySignal"],
      });
    }
  });
export type SampleTrialResult = z.infer<typeof SampleTrialResultSchema>;

export const MultiTrialSummarySchema = z.object({
  total: safeIntCount(),
  trials: safeIntCount(),
  meanPassRate: finiteRate().optional(),
  noQualitySignal: z.boolean().optional(),
  infraErrorRate: finiteRate().optional(),
  stddevPassRate: z.number().finite().min(0).refine((n) => !Object.is(n, -0), { message: "negative zero is not a valid value" }),
  /** @deprecated Use pooledPassRateCI; this pools heterogeneous sample trials. */
  passRateCI: WilsonCISchema,
  /** Wilson interval over pooled non-infra-error sample trials, not over meanPassRate. */
  pooledPassRateCI: WilsonCISchema.optional(),
}).strict();
export type MultiTrialSummary = z.infer<typeof MultiTrialSummarySchema>;

export const MultiTrialResultBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    taskId: z.string(),
    taskVersion: z.string(),
    gitSha: z.string().optional(),
    model: z.string().optional(),
    dryRun: z.boolean().optional(),
    trials: safeIntCount(),
    startedAt: z.string(),
    finishedAt: z.string(),
    summary: MultiTrialSummarySchema,
    samples: z.array(SampleTrialResultSchema),
    rawRuns: z.array(RunResultSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Structural invariants only (no semantic meanPassRate check). CIGate runs
    // this base schema first via F11; the meanPassRate consistency check lives
    // in the outer refined `MultiTrialResultSchema` so that callers with
    // `trustSummary: true` (and CIGate's own integrity check) can opt out
    // independently.
    const duplicates = duplicateIds(val.samples, (sample) => sample.sampleId);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate sample IDs in MultiTrialResult: ${duplicates.join(", ")}`,
        path: ["samples"],
      });
    }
    if (val.summary.total !== val.samples.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `summary.total (${val.summary.total}) must equal samples.length (${val.samples.length})`,
        path: ["summary", "total"],
      });
    }
  });

export const MultiTrialResultSchema = MultiTrialResultBaseSchema
  .superRefine((val, ctx) => {
    const MEAN_EPSILON = 1e-9;
    const CI_EPSILON = 1e-6;
    if (val.summary.meanPassRate !== undefined) {
      const sampleRates = val.samples
        .map((s) => s.passRate)
        .filter((r): r is number => typeof r === "number");
      if (sampleRates.length === 0) {
        // F6: every sample is no-quality (or samples is empty); a meanPassRate
        // here would be fabricated.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "summary.meanPassRate must be undefined when no sample has a passRate (all samples have noQualitySignal=true or samples is empty)",
          path: ["summary", "meanPassRate"],
        });
      } else {
        const expected = sampleRates.reduce((a, b) => a + b, 0) / sampleRates.length;
        if (Math.abs(val.summary.meanPassRate - expected) >= MEAN_EPSILON) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `summary.meanPassRate (${val.summary.meanPassRate}) does not match unweighted mean of sample passRates (${expected})`,
            path: ["summary", "meanPassRate"],
          });
        }
      }
    }

    // H9 (iter19): rawRuns coherence. Non-dry results must have one rawRun per trial.
    // Dry-run results (`dryRun: true`) record no underlying runs; permit empty.
    if (!val.dryRun) {
      if (val.rawRuns.length !== val.trials) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rawRuns.length (${val.rawRuns.length}) must equal trials (${val.trials}) for non-dry results`,
          path: ["rawRuns"],
        });
      }
      // Sample-level coherence: per-sample trials must equal top-level trials.
      for (let i = 0; i < val.samples.length; i++) {
        const s = val.samples[i]!;
        if (s.trials !== val.trials) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `samples[${i}].trials (${s.trials}) must equal top-level trials (${val.trials}) for non-dry results`,
            path: ["samples", i, "trials"],
          });
        }
      }
    }

    // H2 (iter19): CI drift. Recompute the pooled Wilson CI from sample
    // counts and reject the supplied pooledPassRateCI if it disagrees by
    // more than CI_EPSILON. The legacy `passRateCI` field is preserved
    // verbatim (it pools heterogeneous trials and is deprecated); modern
    // callers MUST set `pooledPassRateCI` for the integrity check.
    if (
      !val.dryRun &&
      val.samples.length > 0 &&
      val.summary.pooledPassRateCI !== undefined
    ) {
      let totalPasses = 0;
      let totalNonError = 0;
      let anyQuality = false;
      for (const s of val.samples) {
        const denom = s.trials - s.errorCount;
        totalPasses += s.passCount;
        totalNonError += denom;
        if (denom > 0) anyQuality = true;
      }
      if (anyQuality) {
        let computed: { lower: number; upper: number; point: number; z: number } | undefined;
        try {
          computed = wilsonInterval(totalPasses, totalNonError);
        } catch {
          // bounds checks elsewhere will surface; skip CI drift.
        }
        if (computed) {
          const supplied = val.summary.pooledPassRateCI;
          if (
            Math.abs(supplied.lower - computed.lower) > CI_EPSILON ||
            Math.abs(supplied.upper - computed.upper) > CI_EPSILON ||
            Math.abs(supplied.point - computed.point) > CI_EPSILON
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `summary.pooledPassRateCI does not match pooled Wilson interval over ` +
                `samples (passes=${totalPasses}, nonError=${totalNonError}). ` +
                `expected ~{lower:${computed.lower}, upper:${computed.upper}, point:${computed.point}}, ` +
                `got {lower:${supplied.lower}, upper:${supplied.upper}, point:${supplied.point}}`,
              path: ["summary", "pooledPassRateCI"],
            });
          }
        }
      }
    }
  });
export type MultiTrialResult = z.infer<typeof MultiTrialResultSchema>;

export const MatrixConfigOverridesSchema = z.object({
  systemMessage: z.string().optional(),
  timeoutMs: safePosInt().optional(),
}).strict();
export type MatrixConfigOverrides = z.infer<typeof MatrixConfigOverridesSchema>;

export const MatrixConfigSchema = z.object({
  id: nonblankString(),
  label: nonblankString(),
  overrides: MatrixConfigOverridesSchema,
}).strict();
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

export const MatrixCellSchema = z.object({
  model: nonblankString(),
  configId: nonblankString(),
  configLabel: z.string(),
  result: MultiTrialResultSchema,
}).strict();
export type MatrixCell = z.infer<typeof MatrixCellSchema>;

export const MatrixPassRateRefSchema = z.object({
  model: nonblankString(),
  configId: nonblankString(),
  passRate: finiteRate().optional(),
}).strict();

export const MatrixSummarySchema = z.object({
  totalCells: safeIntCount(),
  bestPassRate: MatrixPassRateRefSchema,
  worstPassRate: MatrixPassRateRefSchema,
}).strict();
export type MatrixSummary = z.infer<typeof MatrixSummarySchema>;

export const MatrixResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    taskId: z.string(),
    taskVersion: z.string(),
    gitSha: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string(),
    models: z.array(nonblankString()),
    configs: z.array(MatrixConfigSchema),
    cells: z.array(MatrixCellSchema),
    summary: MatrixSummarySchema,
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.cells.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MatrixResult.cells must not be empty",
        path: ["cells"],
      });
    }
    if (val.summary.totalCells !== val.cells.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `summary.totalCells (${val.summary.totalCells}) must equal cells.length (${val.cells.length})`,
        path: ["summary", "totalCells"],
      });
    }
    const modelSet = new Set(val.models);
    const configSet = new Set(val.configs.map((c) => c.id));

    // duplicate detection on declared dimensions
    if (modelSet.size !== val.models.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate entries in models[]",
        path: ["models"],
      });
    }
    if (configSet.size !== val.configs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate ids in configs[]",
        path: ["configs"],
      });
    }

    // per-cell coherence + duplicate (model, configId) pair detection
    const seenPairs = new Set<string>();
    for (let i = 0; i < val.cells.length; i++) {
      const cell = val.cells[i];
      if (!modelSet.has(cell.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cells[${i}].model (${cell.model}) is not present in models[]`,
          path: ["cells", i, "model"],
        });
      }
      if (!configSet.has(cell.configId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cells[${i}].configId (${cell.configId}) is not present in configs[].id`,
          path: ["cells", i, "configId"],
        });
      }
      if (cell.result.taskId !== val.taskId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cells[${i}].result.taskId (${cell.result.taskId}) must equal MatrixResult.taskId (${val.taskId})`,
          path: ["cells", i, "result", "taskId"],
        });
      }
      if (cell.result.taskVersion !== val.taskVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cells[${i}].result.taskVersion (${cell.result.taskVersion}) must equal MatrixResult.taskVersion (${val.taskVersion})`,
          path: ["cells", i, "result", "taskVersion"],
        });
      }
      if (cell.result.model !== undefined && cell.result.model !== cell.model) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cells[${i}].result.model (${cell.result.model}) must equal cells[${i}].model (${cell.model})`,
          path: ["cells", i, "result", "model"],
        });
      }
      const pairKey = `${cell.model}\u0000${cell.configId}`;
      if (seenPairs.has(pairKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate cell for (model=${cell.model}, configId=${cell.configId})`,
          path: ["cells", i],
        });
      } else {
        seenPairs.add(pairKey);
      }
    }

    // B2 (iter19): Cartesian completeness — every (model, configId) pair
    // must be present in cells exactly once, and cells.length must equal
    // models.length × configs.length.
    const expectedCells = val.models.length * val.configs.length;
    if (val.cells.length !== expectedCells) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cells.length (${val.cells.length}) must equal models.length × configs.length (${expectedCells})`,
        path: ["cells"],
      });
    }
    for (const m of val.models) {
      for (const cfg of val.configs) {
        const key = `${m}\u0000${cfg.id}`;
        if (!seenPairs.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `cells is missing (model=${m}, configId=${cfg.id}) — Cartesian product must be complete`,
            path: ["cells"],
          });
        }
      }
    }

    for (const which of ["bestPassRate", "worstPassRate"] as const) {
      const ref = val.summary[which];
      if (!modelSet.has(ref.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `summary.${which}.model (${ref.model}) is not present in models[]`,
          path: ["summary", which, "model"],
        });
      }
      if (!configSet.has(ref.configId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `summary.${which}.configId (${ref.configId}) is not present in configs[].id`,
          path: ["summary", which, "configId"],
        });
      }
    }
  });
export type MatrixResult = z.infer<typeof MatrixResultSchema>;

export const MissingScorePolicySchema = z.enum(["exclude", "zero"]);
export type MissingScorePolicy = z.infer<typeof MissingScorePolicySchema>;

// ---------------------------------------------------------------------------
// V3: durability / crash-recovery types
// ---------------------------------------------------------------------------

export const DurabilityFaultPointSchema = z.enum([
  "before_turn",
  "during_tool_call",
  "after_tool_call",
  "after_turn",
  "after_dehydrate",
  "before_hydrate",
]);
export type DurabilityFaultPoint = z.infer<typeof DurabilityFaultPointSchema>;

export const DurabilityFaultModeSchema = z.enum([
  "worker_crash",
  "tool_timeout",
  "tool_throw",
  "network_disconnect",
]);
export type DurabilityFaultMode = z.infer<typeof DurabilityFaultModeSchema>;

export const DurabilityObservationSchema = z.object({
  scenario: z.string(),
  faultPoint: DurabilityFaultPointSchema,
  faultMode: DurabilityFaultModeSchema,
  injected: z.boolean(),
  recovered: z.boolean(),
  preCrashState: z.string().optional(),
  postRecoveryState: z.string().optional(),
  toolCallsBeforeFault: safeIntCount(),
  toolCallsAfterRecovery: safeIntCount(),
  timerAccuracyMs: z.number().finite().optional(),
  dehydrated: z.boolean().optional(),
  hydrated: z.boolean().optional(),
  workerHandoff: z.boolean().optional(),
}).passthrough();
export type DurabilityObservation = z.infer<typeof DurabilityObservationSchema>;

export const DurabilityExpectedSchema = z.object({
  mustRecover: z.boolean().default(true),
  finalStateIn: z.array(z.string()).optional(),
  minToolCallsAfterRecovery: safeIntCount().optional(),
  maxTimerDriftMs: finiteNonNegative().optional(),
  requireDehydrated: z.boolean().optional(),
  requireHydrated: z.boolean().optional(),
  requireWorkerHandoff: z.boolean().optional(),
});
export type DurabilityExpected = z.infer<typeof DurabilityExpectedSchema>;

// ---------------------------------------------------------------------------
// V4: multi-turn / trajectory types
// ---------------------------------------------------------------------------

export const TurnExpectedSchema = z
  .object({
    toolCalls: z.array(EvalToolCallSchema).optional(),
    toolSequence: z.enum(["strict", "subsequence", "exactSequence", "unordered"]).default("unordered"),
    forbiddenTools: z.array(z.string().min(1)).optional(),
    noToolCall: z.boolean().optional(),
    response: z
      .object({
        containsAny: z.array(z.string()).optional(),
        containsAll: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.noToolCall === true && val.toolCalls && val.toolCalls.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noToolCall=true cannot be combined with non-empty toolCalls",
        path: ["noToolCall"],
      });
    }
  });
export type TurnExpected = z.infer<typeof TurnExpectedSchema>;

export function hasTurnExpectedCriteria(expected: TurnExpected): boolean {
  return (
    (expected.toolCalls?.length ?? 0) > 0 ||
    (expected.forbiddenTools?.length ?? 0) > 0 ||
    expected.noToolCall === true ||
    (expected.response?.containsAny?.length ?? 0) > 0 ||
    (expected.response?.containsAll?.length ?? 0) > 0
  );
}

export const TurnInputSchema = z.object({
  prompt: z.string(),
  systemMessage: z.string().optional(),
}).strict();
export type TurnInput = z.infer<typeof TurnInputSchema>;

export const TrajectoryTurnSchema = z.object({
  input: TurnInputSchema,
  expected: TurnExpectedSchema,
}).strict().superRefine((val, ctx) => {
  if (!hasTurnExpectedCriteria(val.expected)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "trajectory turn has no expected criteria",
      path: ["expected"],
    });
  }
});
export type TrajectoryTurn = z.infer<typeof TrajectoryTurnSchema>;

export const TrajectorySampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  turns: z.array(TrajectoryTurnSchema).min(1),
  tools: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: safePosInt().default(120000),
  expected: z
    .object({
      goalCompleted: z.boolean().optional(),
      maxTotalToolCalls: safeIntCount().optional(),
      contextRetention: z
        .array(
            z.object({
              term: z.string(),
              mustAppearAfterTurn: safeIntCount(),
              requireToolArgUse: z
                .object({
                  toolName: z.string().min(1),
                  argPath: z.string().min(1),
                })
                .strict()
                .optional(),
            }).strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
}).strict();
export type TrajectorySample = z.infer<typeof TrajectorySampleSchema>;

export const TrajectoryTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    runnable: z.boolean().default(true),
    passRateFloor: finiteRate().refine((n) => n > 0, { message: "passRateFloor must be > 0" }).optional(),
    samples: z.array(TrajectorySampleSchema).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const duplicates = duplicateIds(val.samples, (sample) => sample.id);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate sample IDs in TrajectoryTask: ${duplicates.join(", ")}`,
        path: ["samples"],
      });
    }
  });
export type TrajectoryTask = z.infer<typeof TrajectoryTaskSchema>;

export const ObservedTurnSchema = z.object({
  toolCalls: z.array(ObservedToolCallSchema),
  response: z.string(),
  latencyMs: finiteNonNegative(),
}).passthrough();
export type ObservedTurn = z.infer<typeof ObservedTurnSchema>;

export const ObservedTrajectorySchema = z.object({
  turns: z.array(ObservedTurnSchema),
  sessionId: z.string(),
  totalLatencyMs: finiteNonNegative(),
  model: z.string().optional(),
}).passthrough();
export type ObservedTrajectory = z.infer<typeof ObservedTrajectorySchema>;

export const TrajectoryScoreSchema = z.object({
  turnScores: z.array(z.array(ScoreSchema)),
  crossTurnScores: z.array(ScoreSchema),
  holisticScores: z.array(ScoreSchema),
}).strict();
export type TrajectoryScore = z.infer<typeof TrajectoryScoreSchema>;

export const TrajectoryCaseResultSchema = z.object({
  caseId: z.string(),
  pass: z.boolean(),
  trajectoryScore: TrajectoryScoreSchema,
  observed: ObservedTrajectorySchema,
  infraError: z.string().optional(),
  durationMs: finiteNonNegative(),
}).strict();
export type TrajectoryCaseResult = z.infer<typeof TrajectoryCaseResultSchema>;

export const TrajectoryRunResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: z.object({
    total: safeIntCount(),
    passed: safeIntCount(),
    failed: safeIntCount(),
    errored: safeIntCount(),
    passRate: finiteRate().optional(),
    noQualitySignal: z.boolean().optional(),
    infraErrorRate: finiteRate().optional(),
  }).strict(),
  cases: z.array(TrajectoryCaseResultSchema),
}).strict().superRefine((val, ctx) => {
  const PASSRATE_EPSILON = 1e-9;
  const { summary, cases } = val;
  // H3 (iter19): duplicate caseId rejection.
  const dupes = duplicateIds(cases, (c) => c.caseId);
  if (dupes.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate caseId in TrajectoryRunResult.cases: ${dupes.join(", ")}`,
      path: ["cases"],
    });
  }
  if (summary.total !== cases.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.total (${summary.total}) must equal cases.length (${cases.length})`,
      path: ["summary", "total"],
    });
  }
  if (summary.passed + summary.failed + summary.errored !== summary.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.passed + summary.failed + summary.errored (${summary.passed + summary.failed + summary.errored}) must equal summary.total (${summary.total})`,
      path: ["summary", "total"],
    });
  }
  const passedActual = cases.filter((c) => c.pass === true).length;
  const erroredActual = cases.filter((c) => c.infraError !== undefined).length;
  const failedActual = cases.filter((c) => c.pass === false && c.infraError === undefined).length;
  if (summary.passed !== passedActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.passed (${summary.passed}) does not match cases.filter(c=>c.pass).length (${passedActual})`,
      path: ["summary", "passed"],
    });
  }
  if (summary.failed !== failedActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.failed (${summary.failed}) does not match cases.filter(c=>!c.pass && !c.infraError).length (${failedActual})`,
      path: ["summary", "failed"],
    });
  }
  if (summary.errored !== erroredActual) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `summary.errored (${summary.errored}) does not match cases.filter(c=>c.infraError).length (${erroredActual})`,
      path: ["summary", "errored"],
    });
  }
  const denom = summary.passed + summary.failed;
  if (denom > 0) {
    if (summary.passRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "summary.passRate is required when summary.passed + summary.failed > 0",
        path: ["summary", "passRate"],
      });
    } else {
      const expected = summary.passed / denom;
      if (Math.abs(summary.passRate - expected) >= PASSRATE_EPSILON) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `summary.passRate (${summary.passRate}) does not match passed / (passed + failed) = ${expected}`,
          path: ["summary", "passRate"],
        });
      }
    }
  } else if (summary.noQualitySignal !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "summary.noQualitySignal=true is required when passed + failed === 0",
      path: ["summary", "noQualitySignal"],
    });
  }
});
export type TrajectoryRunResult = z.infer<typeof TrajectoryRunResultSchema>;

// V5: LLM-as-Judge types

export const RubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    scale: z.object({
      min: z.number().int().min(0).refine((n) => Number.isSafeInteger(n), { message: "value must be a safe integer" }),
      max: z.number().int().min(1).refine((n) => Number.isSafeInteger(n), { message: "value must be a safe integer" }),
    }).strict(),
    anchors: z.record(z.string(), z.string()).optional(),
    passThreshold: finiteRate(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.scale.min >= val.scale.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scale.min (${val.scale.min}) must be less than scale.max (${val.scale.max})`,
        path: ["scale", "min"],
      });
    }
  });
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    criteria: z.array(RubricCriterionSchema).min(1),
  })
  .strict()
  .superRefine((val, ctx) => {
    const ids = val.criteria.map((c) => c.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate criterion IDs found",
        path: ["criteria"],
      });
    }
  });
export type Rubric = z.infer<typeof RubricSchema>;

export const JudgeResultSchema = z.object({
  criterionId: z.string(),
  reasoning: z.string(),
  rawScore: z.number().finite(),
  normalizedScore: finiteRate(),
  pass: z.boolean(),
}).strict();
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const JudgeCostSchema = z.object({
  inputTokens: safeIntCount(),
  outputTokens: safeIntCount(),
  model: z.string(),
  estimatedCostUsd: finiteCost().optional(),
}).strict();
export type JudgeCost = z.infer<typeof JudgeCostSchema>;

// ---------------------------------------------------------------------------
// V5b: CI Gate / Regression / Baseline types
// ---------------------------------------------------------------------------

export const CIGateConfigSchema = z.object({
  /**
   * Minimum acceptable mean pass rate, in (0, 1]. A floor of 0 is rejected
   * because it cannot fail any run and therefore is not a quality gate;
   * use `undefined` (omit the field) if you don't want to enforce a floor.
   */
  passRateFloor: finiteRate().refine((n) => n > 0, { message: "passRateFloor must be > 0" }).optional(),
  maxRegressions: safeIntCount().optional(),
  maxCostUsd: finiteCost().optional(),
  maxInfraErrors: safeIntCount().optional(),
  requireNoInfraOutage: z.boolean().default(true),
  allowMissingBaselineSamples: z.boolean().default(false),
  /**
   * When true (default), CIGate fails if the current run contains samples
   * not present in the baseline. Defaulting to true is the safe choice:
   * silently accepting newly added samples can mask scope drift in CI.
   * Opt out explicitly with `failOnNewSamples: false` when adding samples
   * intentionally.
   */
  failOnNewSamples: z.boolean().default(true),
  trustSummary: z.boolean().default(false),
}).strict();
export type CIGateConfig = z.infer<typeof CIGateConfigSchema>;

export const CIGateResultSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
  passRate: finiteRate().optional(),
  regressionCount: safeIntCount().optional(),
  totalCostUsd: finiteCost().optional(),
}).strict();
export type CIGateResult = z.infer<typeof CIGateResultSchema>;

export const RegressionResultSchema = z.object({
  sampleId: z.string(),
  baselinePassRate: finiteRate(),
  currentPassRate: finiteRate(),
  pValue: finitePValue(),
  adjustedPValue: finitePValue().optional(),
  correction: z.enum(["none", "bonferroni", "bh"]).optional(),
  significant: z.boolean(),
  direction: z.enum(["improved", "regressed", "unchanged"]),
}).strict();
export type RegressionResult = z.infer<typeof RegressionResultSchema>;

export const RegressionDetectionResultSchema = z.object({
  regressions: z.array(RegressionResultSchema),
  missingBaselineSamples: z.array(z.string()),
  newCurrentSamples: z.array(z.string()),
  /**
   * F1: sample IDs in the current run that had no quality signal
   * (passRate undefined or noQualitySignal=true). These are NOT regressions —
   * they are infra outages on the current side and are reported separately so
   * downstream gates (CIGate) and reporters (PRCommentReporter) can render
   * them as outages instead of synthesizing 0% regression entries.
   */
  noQualityCurrentSamples: z.array(z.string()).default([]),
}).strict();
export type RegressionDetectionResult = z.infer<typeof RegressionDetectionResultSchema>;

export const BaselineSampleSchema = z.object({
  sampleId: z.string().min(1),
  passRate: finiteRate(),
  trials: safeIntCount(),
  nonErrorTrials: safeIntCount().optional(),
  infraErrorCount: safeIntCount().optional(),
  passCount: safeIntCount(),
}).strict().superRefine((val, ctx) => {
  const PASSRATE_EPSILON = 1e-9;
  if (val.infraErrorCount !== undefined && val.nonErrorTrials === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "nonErrorTrials must be supplied when infraErrorCount is supplied",
      path: ["nonErrorTrials"],
    });
    return;
  }
  const nonErrorTrials = val.nonErrorTrials ?? val.trials;
  if (val.passCount > nonErrorTrials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "passCount must be <= nonErrorTrials",
      path: ["passCount"],
    });
  }
  // F11: enforce per-field upper bounds against `trials` even when only one
  // of nonErrorTrials/infraErrorCount is supplied.
  if (val.infraErrorCount !== undefined && val.infraErrorCount > val.trials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `infraErrorCount (${val.infraErrorCount}) must be <= trials (${val.trials})`,
      path: ["infraErrorCount"],
    });
  }
  if (val.nonErrorTrials !== undefined && val.nonErrorTrials > val.trials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `nonErrorTrials (${val.nonErrorTrials}) must be <= trials (${val.trials})`,
      path: ["nonErrorTrials"],
    });
  }
  if (
    val.nonErrorTrials !== undefined &&
    val.infraErrorCount !== undefined &&
    val.nonErrorTrials + val.infraErrorCount !== val.trials
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "nonErrorTrials + infraErrorCount must equal trials",
      path: ["nonErrorTrials"],
    });
  }
  // F7: when there is no quality signal (denom 0), passRate must be 0.
  if (nonErrorTrials === 0 && val.passRate !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "passRate must be 0 when nonErrorTrials === 0 (no quality signal)",
      path: ["passRate"],
    });
  }
  if (nonErrorTrials > 0) {
    const expected = val.passCount / nonErrorTrials;
    if (Math.abs(val.passRate - expected) >= PASSRATE_EPSILON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `passRate (${val.passRate}) does not match passCount / nonErrorTrials = ${expected}`,
        path: ["passRate"],
      });
    }
  }
});
export type BaselineSample = z.infer<typeof BaselineSampleSchema>;

export const BaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    taskVersion: z.string().min(1),
    model: z.string().optional(),
    createdAt: z.string(),
    samples: z.array(BaselineSampleSchema).min(1, {
      message: "Baseline.samples must contain at least one sample (empty baselines are not permitted)",
    }),
  })
  .strict()
  .superRefine((val, ctx) => {
    const duplicates = duplicateIds(val.samples, (sample) => sample.sampleId);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate sample IDs in Baseline: ${duplicates.join(", ")}`,
        path: ["samples"],
      });
    }
  });
export type Baseline = z.infer<typeof BaselineSchema>;

/**
 * Lenient variant of BaselineSchema that permits `samples: []`. This is the
 * explicit-opt-in path used by `loadBaseline`/`saveBaseline` when the caller
 * passes `{ allowEmptyBaseline: true }`. Public callers should prefer
 * `BaselineSchema` (which rejects empty samples at the schema layer per
 * iter15 F21).
 */
export const BaselineSchemaAllowEmpty = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    taskVersion: z.string().min(1),
    model: z.string().optional(),
    createdAt: z.string(),
    samples: z.array(BaselineSampleSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    const duplicates = duplicateIds(val.samples, (sample) => sample.sampleId);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate sample IDs in Baseline: ${duplicates.join(", ")}`,
        path: ["samples"],
      });
    }
  });
