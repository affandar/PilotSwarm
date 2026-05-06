import { describe, it, expect } from "vitest";
import {
  EvalTaskSchema,
  EvalSampleSchema,
  EvalToolCallSchema,
  EvalExpectedSchema,
  RunResultSchema,
  CaseResultSchema,
  ScoreSchema,
  ObservedResultSchema,
  ObservedToolCallSchema,
  TrajectoryTaskSchema,
  BaselineSchema,
  BaselineSampleSchema,
  MultiTrialResultSchema,
  SampleTrialResultSchema,
  CIGateConfigSchema,
  WilsonCISchema,
  TurnExpectedSchema,
  MatrixResultSchema,
  EvalContextMessageSchema,
  EvalSampleInputSchema,
  MatrixConfigOverridesSchema,
} from "../src/types.js";
import type {
  MultipleTestingCorrection,
  RegressionDetectorConfig,
} from "../src/index.js";

const validTask = {
  schemaVersion: 1,
  id: "task.basic",
  name: "Basic Task",
  description: "A basic eval task",
  version: "1.0.0",
  samples: [
    {
      id: "single.add.basic",
      description: "Add two numbers",
      input: { prompt: "What is 2+2?" },
      expected: {
        toolCalls: [{ name: "test_add", args: { a: 2, b: 2 } }],
      },
    },
  ],
};

describe("EvalTaskSchema", () => {
  it("exports regression detector config types from the package index", () => {
    const correction: MultipleTestingCorrection = "bh";
    const config: RegressionDetectorConfig = { alpha: 0.05, correction };
    expect(config.correction).toBe("bh");
  });

  it("accepts a valid EvalTask JSON", () => {
    const result = EvalTaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
  });

  it("rejects duplicate sample IDs", () => {
    const duplicate = {
      ...validTask,
      samples: [
        validTask.samples[0],
        { ...validTask.samples[0], description: "duplicate" },
      ],
    };

    expect(() => EvalTaskSchema.parse(duplicate)).toThrow(
      "Duplicate sample IDs in EvalTask: single.add.basic",
    );
  });

  it("rejects missing required fields (id, name, samples)", () => {
    for (const field of ["id", "name", "samples"] as const) {
      const { [field]: _omit, ...rest } = validTask as any;
      const result = EvalTaskSchema.safeParse(rest);
      expect(result.success, `field=${field}`).toBe(false);
    }
  });

  it("rejects invalid schemaVersion (!= 1)", () => {
    const bad = { ...validTask, schemaVersion: 2 };
    const result = EvalTaskSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts any string version (no semver enforcement) and treats passRateFloor as optional", () => {
    const ok = { ...validTask, version: "1.0.0" };
    expect(EvalTaskSchema.safeParse(ok).success).toBe(true);
    const parsed = EvalTaskSchema.parse(validTask);
    expect(parsed.schemaVersion).toBe(1);
  });
});

describe("TrajectoryTaskSchema", () => {
  const validTrajectoryTask = {
    schemaVersion: 1,
    id: "trajectory.basic",
    name: "Trajectory Basic",
    description: "A trajectory eval task",
    version: "1.0.0",
    samples: [
      {
        id: "trajectory.one",
        description: "One",
        turns: [
          {
            input: { prompt: "hello" },
            expected: { noToolCall: true },
          },
        ],
      },
      {
        id: "trajectory.two",
        description: "Two",
        turns: [
          {
            input: { prompt: "hello again" },
            expected: { noToolCall: true },
          },
        ],
      },
    ],
  };

  it("accepts unique sample IDs and rejects duplicates", () => {
    expect(TrajectoryTaskSchema.parse(validTrajectoryTask).samples).toHaveLength(2);
    const duplicate = {
      ...validTrajectoryTask,
      samples: [
        validTrajectoryTask.samples[0],
        { ...validTrajectoryTask.samples[0], description: "duplicate" },
      ],
    };
    expect(() => TrajectoryTaskSchema.parse(duplicate)).toThrow(
      "Duplicate sample IDs in TrajectoryTask: trajectory.one",
    );
  });
});

describe("BaselineSchema", () => {
  const validBaseline = {
    schemaVersion: 1,
    taskId: "task",
    taskVersion: "1.0.0",
    createdAt: "2025-01-01T00:00:00.000Z",
    samples: [
      {
        sampleId: "s1",
        passRate: 1,
        trials: 1,
        nonErrorTrials: 1,
        infraErrorCount: 0,
        passCount: 1,
      },
      {
        sampleId: "s2",
        passRate: 0,
        trials: 1,
        nonErrorTrials: 1,
        infraErrorCount: 0,
        passCount: 0,
      },
    ],
  };

  it("accepts unique sample IDs and rejects duplicates", () => {
    expect(BaselineSchema.parse(validBaseline).samples).toHaveLength(2);
    const duplicate = {
      ...validBaseline,
      samples: [
        validBaseline.samples[0],
        { ...validBaseline.samples[0], passCount: 0, passRate: 0 },
      ],
    };
    expect(() => BaselineSchema.parse(duplicate)).toThrow(
      "Duplicate sample IDs in Baseline: s1",
    );
  });
});

describe("MultiTrialResultSchema", () => {
  const ci = { lower: 0, upper: 1, point: 0.5, z: 1.96 };
  const validMultiTrialResult = {
    schemaVersion: 1,
    runId: "run",
    taskId: "task",
    taskVersion: "1.0.0",
    trials: 1,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:01.000Z",
    summary: {
      total: 2,
      trials: 1,
      meanPassRate: 0.5,
      stddevPassRate: 0,
      passRateCI: ci,
    },
    samples: [
      {
        sampleId: "s1",
        trials: 1,
        passCount: 1,
        failCount: 0,
        errorCount: 0,
        passRate: 1,
        passAtK: {},
        scores: {},
        wilsonCI: ci,
      },
      {
        sampleId: "s2",
        trials: 1,
        passCount: 0,
        failCount: 1,
        errorCount: 0,
        passRate: 0,
        passAtK: {},
        scores: {},
        wilsonCI: ci,
      },
    ],
    rawRuns: [],
    dryRun: true,
  };

  it("accepts unique sample IDs and rejects duplicates", () => {
    expect(MultiTrialResultSchema.parse(validMultiTrialResult).samples).toHaveLength(2);
    const duplicate = {
      ...validMultiTrialResult,
      samples: [
        validMultiTrialResult.samples[0],
        { ...validMultiTrialResult.samples[0], passCount: 0, passRate: 0 },
      ],
    };
    expect(() => MultiTrialResultSchema.parse(duplicate)).toThrow(
      "Duplicate sample IDs in MultiTrialResult: s1",
    );
  });
});

describe("EvalToolCallSchema", () => {
  it("defaults match to 'subset' and validates match mode", () => {
    expect(EvalToolCallSchema.parse({ name: "test_add" }).match).toBe("subset");
    for (const m of ["exact", "subset", "fuzzy", "setEquals"]) {
      expect(EvalToolCallSchema.safeParse({ name: "x", match: m }).success, `mode=${m}`).toBe(true);
    }
    expect(EvalToolCallSchema.safeParse({ name: "x", match: "bogus" }).success).toBe(false);
    expect(EvalToolCallSchema.safeParse({ args: {} }).success).toBe(false);
  });
});

describe("EvalExpectedSchema", () => {
  it("toolSequence: default 'unordered', accepts known modes including deprecated 'strict' alias, rejects invalid", () => {
    expect(EvalExpectedSchema.parse({}).toolSequence).toBe("unordered");
    for (const s of ["strict", "subsequence", "exactSequence", "unordered"]) {
      expect(EvalExpectedSchema.safeParse({ toolSequence: s }).success, `mode=${s}`).toBe(true);
    }
    expect(EvalExpectedSchema.safeParse({ toolSequence: "random" }).success).toBe(false);
  });

  it("accepts forbiddenTools, minCalls, maxCalls, noToolCall, response.contains*, cms.stateIn", () => {
    expect(EvalExpectedSchema.safeParse({
      forbiddenTools: ["a", "b"],
      minCalls: 1,
      maxCalls: 3,
      noToolCall: true,
    }).success).toBe(true);
    expect(EvalExpectedSchema.safeParse({
      response: { containsAny: ["x"], containsAll: ["y"] },
    }).success).toBe(true);
    expect(EvalExpectedSchema.safeParse({ cms: { stateIn: ["Ready", "Idle"] } }).success).toBe(true);
  });

  it("rejects empty response.containsAny/containsAll arrays at expected and sample levels", () => {
    expect(EvalExpectedSchema.safeParse({ response: { containsAny: [] } }).success).toBe(false);
    expect(EvalExpectedSchema.safeParse({ response: { containsAll: [] } }).success).toBe(false);
    expect(EvalSampleSchema.safeParse({
      id: "s1",
      description: "d",
      input: { prompt: "p" },
      expected: { response: { containsAny: [] } },
    }).success).toBe(false);
  });

  it("rejects noToolCall=true with toolCalls entries; accepts when omitted/empty", () => {
    expect(EvalExpectedSchema.safeParse({
      noToolCall: true,
      toolCalls: [{ name: "test_add" }],
    }).success).toBe(false);
    expect(EvalExpectedSchema.safeParse({ noToolCall: true }).success).toBe(true);
    expect(EvalExpectedSchema.safeParse({ noToolCall: true, toolCalls: [] }).success).toBe(true);
  });

  it("rejects minCalls > maxCalls; accepts minCalls === maxCalls", () => {
    expect(EvalExpectedSchema.safeParse({ minCalls: 5, maxCalls: 2 }).success).toBe(false);
    expect(EvalExpectedSchema.safeParse({ minCalls: 3, maxCalls: 3 }).success).toBe(true);
  });
});

describe("EvalSampleSchema", () => {
  it("applies default timeoutMs (120000)", () => {
    const parsed = EvalSampleSchema.parse({
      id: "s1",
      description: "d",
      input: { prompt: "p" },
      expected: { noToolCall: true },
    });
    expect(parsed.timeoutMs).toBe(120000);
  });

  it("accepts context with role user/assistant", () => {
    const r = EvalSampleSchema.safeParse({
      id: "s1",
      description: "d",
      input: {
        prompt: "p",
        context: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      expected: { noToolCall: true },
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid role in context", () => {
    const r = EvalSampleSchema.safeParse({
      id: "s1",
      description: "d",
      input: {
        prompt: "p",
        context: [{ role: "system", content: "x" }],
      },
      expected: { noToolCall: true },
    });
    expect(r.success).toBe(false);
  });
});

describe("ScoreSchema / ObservedResultSchema / CaseResultSchema / RunResultSchema", () => {
  it("validates a Score", () => {
    const r = ScoreSchema.safeParse({
      name: "tool_match",
      value: 1,
      pass: true,
      reason: "matched",
    });
    expect(r.success).toBe(true);
  });

  it("validates an ObservedToolCall with order", () => {
    const r = ObservedToolCallSchema.safeParse({
      name: "t",
      args: { a: 1 },
      order: 0,
    });
    expect(r.success).toBe(true);
  });

  it("validates an ObservedResult", () => {
    const r = ObservedResultSchema.safeParse({
      toolCalls: [],
      finalResponse: "hi",
      sessionId: "s1",
      latencyMs: 42,
    });
    expect(r.success).toBe(true);
  });

  it("validates a CaseResult", () => {
    const r = CaseResultSchema.safeParse({
      caseId: "c1",
      pass: true,
      scores: [],
      observed: {
        toolCalls: [],
        finalResponse: "",
        sessionId: "s1",
        latencyMs: 1,
      },
      durationMs: 1,
    });
    expect(r.success).toBe(true);
  });

  it("validates a full RunResult", () => {
    const r = RunResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r1",
      taskId: "t1",
      taskVersion: "1.0.0",
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1 },
      cases: [
        {
          caseId: "c1",
          pass: true,
          scores: [],
          observed: {
            toolCalls: [],
            finalResponse: "",
            sessionId: "s1",
            latencyMs: 1,
          },
          durationMs: 1,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects RunResult with invalid schemaVersion", () => {
    const r = RunResultSchema.safeParse({
      schemaVersion: 99,
      runId: "r1",
      taskId: "t1",
      taskVersion: "1.0.0",
      startedAt: "x",
      finishedAt: "y",
      summary: { total: 0, passed: 0, failed: 0, errored: 0, passRate: 0 },
      cases: [],
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS1 invariants (iter11): arithmetic + strict + cross-check refinements
// ---------------------------------------------------------------------------

const ci01 = { lower: 0, upper: 1, point: 0.5, z: 1.96 };

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    sampleId: "s1",
    trials: 5,
    passCount: 4,
    failCount: 1,
    errorCount: 0,
    passRate: 0.8,
    passAtK: {},
    scores: {},
    wilsonCI: ci01,
    ...overrides,
  };
}

describe("F1: SampleTrialResultSchema arithmetic invariants", () => {
  it("accepts arithmetically valid counts (4 + 1 + 0 === 5)", () => {
    expect(SampleTrialResultSchema.safeParse(makeSample()).success).toBe(true);
  });

  it("rejects passCount + failCount + errorCount !== trials", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ passCount: 3, failCount: 1, errorCount: 0, passRate: 0.6 }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects passCount > trials - errorCount", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ trials: 4, passCount: 4, failCount: 0, errorCount: 1 }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects errorCount > trials", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ trials: 2, passCount: 0, failCount: 0, errorCount: 3 }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects passRate that does not match passCount / (trials - errorCount)", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ trials: 4, passCount: 2, failCount: 2, errorCount: 0, passRate: 0.9 }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts passRate that matches passCount / (trials - errorCount) within 1e-9", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ trials: 3, passCount: 2, failCount: 0, errorCount: 1, passRate: 1 }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects passRate set when no quality signal (trials - errorCount === 0)", () => {
    const r = SampleTrialResultSchema.safeParse(
      makeSample({ trials: 3, passCount: 0, failCount: 0, errorCount: 3, passRate: 0 }),
    );
    expect(r.success).toBe(false);
  });

  it("requires noQualitySignal=true to imply trials - errorCount === 0", () => {
    const bad = SampleTrialResultSchema.safeParse(
      makeSample({ noQualitySignal: true, passRate: undefined }),
    );
    expect(bad.success).toBe(false);
    const ok = SampleTrialResultSchema.safeParse(
      makeSample({
        trials: 3,
        passCount: 0,
        failCount: 0,
        errorCount: 3,
        passRate: undefined,
        noQualitySignal: true,
      }),
    );
    expect(ok.success).toBe(true);
  });
});

describe("F1: MultiTrialResultSchema arithmetic invariants", () => {
  function makeResult(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1.0",
      dryRun: true,
      trials: 1,
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: {
        total: 2,
        trials: 1,
        meanPassRate: 0.5,
        stddevPassRate: 0,
        passRateCI: ci01,
      },
      samples: [
        makeSample({ sampleId: "s1", trials: 1, passCount: 1, failCount: 0, errorCount: 0, passRate: 1 }),
        makeSample({ sampleId: "s2", trials: 1, passCount: 0, failCount: 1, errorCount: 0, passRate: 0 }),
      ],
      rawRuns: [],
      ...overrides,
    };
  }

  it("accepts a result where summary.total === samples.length and meanPassRate matches", () => {
    expect(MultiTrialResultSchema.safeParse(makeResult()).success).toBe(true);
  });

  it("rejects summary.total !== samples.length", () => {
    const r = MultiTrialResultSchema.safeParse(
      makeResult({ summary: { total: 5, trials: 1, stddevPassRate: 0, meanPassRate: 0.5, passRateCI: ci01 } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects summary.meanPassRate that does not match the unweighted mean of sample passRates", () => {
    const r = MultiTrialResultSchema.safeParse(
      makeResult({
        summary: { total: 2, trials: 1, meanPassRate: 0.99, stddevPassRate: 0, passRateCI: ci01 },
      }),
    );
    expect(r.success).toBe(false);
  });
});

describe("F8: CIGateConfigSchema.passRateFloor must be > 0", () => {
  it("rejects 0; accepts (0,1] and undefined", () => {
    expect(CIGateConfigSchema.safeParse({ passRateFloor: 0 }).success).toBe(false);
    expect(CIGateConfigSchema.safeParse({ passRateFloor: 0.01 }).success).toBe(true);
    expect(CIGateConfigSchema.safeParse({ passRateFloor: 1 }).success).toBe(true);
    expect(CIGateConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("F10: CIGateConfigSchema.failOnNewSamples defaults to true", () => {
  it("defaults to true and preserves explicit failOnNewSamples=false", () => {
    expect(CIGateConfigSchema.parse({}).failOnNewSamples).toBe(true);
    expect(CIGateConfigSchema.parse({ failOnNewSamples: false }).failOnNewSamples).toBe(false);
  });
});

describe("F12: strict task schemas reject typos", () => {
  const validTaskF12 = {
    schemaVersion: 1,
    id: "t",
    name: "T",
    description: "d",
    version: "1.0",
    samples: [
      {
        id: "s1",
        description: "d",
        input: { prompt: "p" },
        expected: { noToolCall: true },
      },
    ],
  };

  it("EvalTaskSchema and TrajectoryTaskSchema reject unknown top-level typos and accept legitimate 'runnable' key", () => {
    expect(EvalTaskSchema.safeParse({ ...validTaskF12, runnnable: false }).success).toBe(false);
    expect(EvalTaskSchema.safeParse({ ...validTaskF12, runnable: false }).success).toBe(true);

    const validTrajF12 = {
      schemaVersion: 1,
      id: "t",
      name: "T",
      description: "d",
      version: "1.0",
      samples: [
        {
          id: "s1",
          description: "d",
          turns: [{ input: { prompt: "p" }, expected: { noToolCall: true } }],
        },
      ],
    };
    expect(TrajectoryTaskSchema.safeParse({ ...validTrajF12, runnnable: false }).success).toBe(false);
    expect(TrajectoryTaskSchema.safeParse({ ...validTrajF12, runnable: false }).success).toBe(true);
  });
});

describe("F15: BaselineSampleSchema passRate cross-check", () => {
  it("accepts passRate matching passCount/nonErrorTrials (or /trials when nonErrorTrials omitted); rejects mismatch", () => {
    expect(BaselineSampleSchema.safeParse({
      sampleId: "s1", passRate: 0.5, trials: 4, nonErrorTrials: 4, infraErrorCount: 0, passCount: 2,
    }).success).toBe(true);
    expect(BaselineSampleSchema.safeParse({
      sampleId: "s1", passRate: 0.5, trials: 4, passCount: 2,
    }).success).toBe(true);
    expect(BaselineSampleSchema.safeParse({
      sampleId: "s1", passRate: 0.9, trials: 4, nonErrorTrials: 4, infraErrorCount: 0, passCount: 2,
    }).success).toBe(false);
  });
});

describe("F17: ScoreSchema requires pass=false when infraError=true", () => {
  it("rejects infraError=true with pass=true; accepts infraError=true with pass=false; accepts pass=true when infraError unset/false", () => {
    expect(ScoreSchema.safeParse({ name: "x", value: 0, pass: true, reason: "boom", infraError: true }).success).toBe(false);
    expect(ScoreSchema.safeParse({ name: "x", value: 0, pass: false, reason: "boom", infraError: true }).success).toBe(true);
    expect(ScoreSchema.safeParse({ name: "x", value: 1, pass: true, reason: "ok" }).success).toBe(true);
    expect(ScoreSchema.safeParse({ name: "x", value: 1, pass: true, reason: "ok", infraError: false }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS1 invariants (iter13): F5–F13
// ---------------------------------------------------------------------------

const ciValid = { lower: 0, upper: 1, point: 0.5, z: 1.96 };

describe("F5: SampleTrialResultSchema noQualitySignal required when denom=0", () => {
  it("rejects denom=0 unless noQualitySignal=true; accepts denom=0 with noQualitySignal=true and no passRate", () => {
    const base = {
      sampleId: "s1",
      trials: 3,
      passCount: 0,
      failCount: 0,
      errorCount: 3,
      passAtK: {},
      scores: {},
      wilsonCI: ciValid,
    };
    expect(SampleTrialResultSchema.safeParse(base).success, "missing noQualitySignal").toBe(false);
    expect(SampleTrialResultSchema.safeParse({ ...base, noQualitySignal: false }).success, "noQualitySignal=false").toBe(false);
    expect(SampleTrialResultSchema.safeParse({ ...base, noQualitySignal: true }).success, "noQualitySignal=true").toBe(true);
  });
});

describe("F6: MultiTrialResultSchema rejects fabricated meanPassRate when all samples are no-quality", () => {
  function noQualitySample(id: string) {
    return {
      sampleId: id,
      trials: 1,
      passCount: 0,
      failCount: 0,
      errorCount: 1,
      noQualitySignal: true,
      passAtK: {},
      scores: {},
      wilsonCI: ciValid,
    };
  }

  it("rejects meanPassRate set when all samples have noQualitySignal=true", () => {
    const r = MultiTrialResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1.0",
      trials: 1,
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: {
        total: 1,
        trials: 1,
        meanPassRate: 0.5,
        stddevPassRate: 0,
        passRateCI: ciValid,
      },
      samples: [noQualitySample("s1")],
      rawRuns: [],
    });
    expect(r.success).toBe(false);
  });

  it("accepts no-quality samples when meanPassRate is omitted", () => {
    const r = MultiTrialResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1.0",
      dryRun: true,
      trials: 1,
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: {
        total: 1,
        trials: 1,
        stddevPassRate: 0,
        passRateCI: ciValid,
        noQualitySignal: true,
      },
      samples: [noQualitySample("s1")],
      rawRuns: [],
    });
    expect(r.success).toBe(true);
  });
});

describe("F7: BaselineSampleSchema no-quality samples must not carry non-zero passRate", () => {
  it("rejects nonErrorTrials=0 with passRate>0; accepts nonErrorTrials=0 with passRate=0", () => {
    expect(BaselineSampleSchema.safeParse({
      sampleId: "s1", passRate: 0.5, trials: 4, nonErrorTrials: 0, infraErrorCount: 4, passCount: 0,
    }).success).toBe(false);
    expect(BaselineSampleSchema.safeParse({
      sampleId: "s1", passRate: 0, trials: 4, nonErrorTrials: 0, infraErrorCount: 4, passCount: 0,
    }).success).toBe(true);
  });
});

describe("F8: WilsonCISchema enforces lower <= point <= upper", () => {
  it("rejects all orderings that violate lower <= point <= upper", () => {
    const cases: Array<[string, { lower: number; upper: number; point: number; z: number }]> = [
      ["lower > point", { lower: 0.7, upper: 0.9, point: 0.5, z: 1.96 }],
      ["point > upper", { lower: 0.1, upper: 0.5, point: 0.9, z: 1.96 }],
      ["lower > upper", { lower: 0.9, upper: 0.1, point: 0.5, z: 1.96 }],
    ];
    for (const [name, val] of cases) {
      expect(WilsonCISchema.safeParse(val).success, `case=${name}`).toBe(false);
    }
  });

  it("accepts lower <= point <= upper including boundary equality", () => {
    expect(WilsonCISchema.safeParse({ lower: 0.1, upper: 0.9, point: 0.5, z: 1.96 }).success).toBe(true);
    expect(WilsonCISchema.safeParse({ lower: 0.5, upper: 0.5, point: 0.5, z: 1.96 }).success).toBe(true);
  });
});

describe("F9: SampleTrialResultSchema requires passRate when denom>0", () => {
  it("rejects denom>0 with passRate missing/noQualitySignal!==true; accepts when passRate is set", () => {
    const base = {
      sampleId: "s1", trials: 3, passCount: 2, failCount: 1, errorCount: 0,
      passAtK: {}, scores: {}, wilsonCI: ciValid,
    };
    expect(SampleTrialResultSchema.safeParse(base).success).toBe(false);
    expect(SampleTrialResultSchema.safeParse({ ...base, passRate: 2 / 3 }).success).toBe(true);
  });
});

describe("F10: TurnExpectedSchema rejects contradictions like EvalExpectedSchema", () => {
  it("rejects noToolCall=true with non-empty toolCalls; accepts with empty/omitted toolCalls", () => {
    expect(TurnExpectedSchema.safeParse({ noToolCall: true, toolCalls: [{ name: "test_add" }] }).success).toBe(false);
    expect(TurnExpectedSchema.safeParse({ noToolCall: true }).success).toBe(true);
    expect(TurnExpectedSchema.safeParse({ noToolCall: true, toolCalls: [] }).success).toBe(true);
  });
});

describe("F11: BaselineSampleSchema arithmetic when only one of nonErrorTrials/infraErrorCount is present", () => {
  it("rejects infraErrorCount > trials and nonErrorTrials > trials; accepts trials with neither field", () => {
    expect(BaselineSampleSchema.safeParse({ sampleId: "s1", passRate: 0, trials: 1, infraErrorCount: 99, passCount: 0 }).success).toBe(false);
    expect(BaselineSampleSchema.safeParse({ sampleId: "s1", passRate: 0, trials: 1, nonErrorTrials: 99, passCount: 0 }).success).toBe(false);
    expect(BaselineSampleSchema.safeParse({ sampleId: "s1", passRate: 0.5, trials: 4, passCount: 2 }).success).toBe(true);
  });
});

describe("F12: nested input/dataset schemas are .strict()", () => {
  it("rejects unknown keys on EvalToolCall, EvalSampleInput, EvalContextMessage, MatrixConfigOverrides", () => {
    const cases: Array<[string, { success: boolean }]> = [
      ["EvalToolCallSchema", EvalToolCallSchema.safeParse({ name: "x", bogus: true })],
      ["EvalSampleInputSchema typo", EvalSampleInputSchema.safeParse({ prompt: "p", systemMesage: "oops" })],
      ["EvalContextMessageSchema", EvalContextMessageSchema.safeParse({ role: "user", content: "hi", extra: 1 })],
      ["MatrixConfigOverridesSchema", MatrixConfigOverridesSchema.safeParse({ systemMessage: "x", model: "gpt" })],
    ];
    for (const [name, r] of cases) {
      expect(r.success, `case=${name}`).toBe(false);
    }
  });
});

describe("F13: MatrixResultSchema rejects empty / inconsistent shape", () => {
  function makeSampleTR() {
    return {
      sampleId: "s1",
      trials: 1,
      passCount: 1,
      failCount: 0,
      errorCount: 0,
      passRate: 1,
      passAtK: {},
      scores: {},
      wilsonCI: ciValid,
    };
  }
  function makeMTR() {
    return {
      schemaVersion: 1 as const,
      runId: "mt-1",
      taskId: "t",
      taskVersion: "1.0",
      dryRun: true,
      trials: 1,
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:00:01Z",
      summary: {
        total: 1,
        trials: 1,
        meanPassRate: 1,
        stddevPassRate: 0,
        passRateCI: ciValid,
      },
      samples: [makeSampleTR()],
      rawRuns: [],
    };
  }
  function makeMatrix(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1 as const,
      runId: "m-1",
      taskId: "t",
      taskVersion: "1.0",
      startedAt: "2025-01-01T00:00:00Z",
      finishedAt: "2025-01-01T00:01:00Z",
      models: ["gpt-4"],
      configs: [{ id: "default", label: "Default", overrides: {} }],
      cells: [
        {
          model: "gpt-4",
          configId: "default",
          configLabel: "Default",
          result: makeMTR(),
        },
      ],
      summary: {
        totalCells: 1,
        bestPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
        worstPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
      },
      ...overrides,
    };
  }

  it("rejects empty cells array", () => {
    const r = MatrixResultSchema.safeParse(
      makeMatrix({
        cells: [],
        summary: {
          totalCells: 0,
          bestPassRate: { model: "gpt-4", configId: "default", passRate: 0 },
          worstPassRate: { model: "gpt-4", configId: "default", passRate: 0 },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects summary.totalCells !== cells.length", () => {
    const r = MatrixResultSchema.safeParse(
      makeMatrix({
        summary: {
          totalCells: 5,
          bestPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
          worstPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects bestPassRate.model not in models[]", () => {
    const r = MatrixResultSchema.safeParse(
      makeMatrix({
        summary: {
          totalCells: 1,
          bestPassRate: { model: "ghost", configId: "default", passRate: 1 },
          worstPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects worstPassRate.configId not in configs[].id", () => {
    const r = MatrixResultSchema.safeParse(
      makeMatrix({
        summary: {
          totalCells: 1,
          bestPassRate: { model: "gpt-4", configId: "default", passRate: 1 },
          worstPassRate: { model: "gpt-4", configId: "ghost", passRate: 1 },
        },
      }),
    );
    expect(r.success).toBe(false);
  });

  it("accepts a consistent matrix with non-empty cells and refs in models/configs", () => {
    expect(MatrixResultSchema.safeParse(makeMatrix()).success).toBe(true);
  });
});
