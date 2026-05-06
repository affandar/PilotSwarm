import { describe, it, expect } from "vitest";

import { RegressionDetector } from "../src/regression.js";
import type {
  Baseline,
  MultiTrialResult,
  SampleTrialResult,
} from "../src/types.js";

type WilsonCI = { lower: number; upper: number; point: number; z: number };

function makeCI(point: number): WilsonCI {
  return {
    lower: Math.max(0, point - 0.1),
    upper: Math.min(1, point + 0.1),
    point,
    z: 1.96,
  };
}

function makeSample(
  sampleId: string,
  passCount: number,
  trials: number,
  errorCount = 0,
): SampleTrialResult {
  const nonErrorTrials = trials - errorCount;
  const passRate = nonErrorTrials === 0 ? undefined : passCount / nonErrorTrials;
  return {
    sampleId,
    trials,
    passCount,
    failCount: nonErrorTrials - passCount,
    errorCount,
    ...(passRate === undefined ? { noQualitySignal: true as const } : { passRate }),
    passAtK: {},
    scores: {},
    wilsonCI: makeCI(passRate ?? 0),
  };
}

function makeMultiTrial(
  taskId: string,
  trials: number,
  samples: SampleTrialResult[],
  opts: { taskVersion?: string; model?: string } = {},
): MultiTrialResult {
  const taskVersion = opts.taskVersion ?? "1.0.0";
  const qualitySamples = samples.filter((s) => s.passRate !== undefined);
  const meanPassRate =
    qualitySamples.length === 0
      ? undefined
      : qualitySamples.reduce((a, s) => a + (s.passRate ?? 0), 0) / qualitySamples.length;
  const infraErrors = samples.reduce((a, s) => a + s.errorCount, 0);
  const plannedTrials = samples.length * trials;
  return {
    schemaVersion: 1,
    runId: `${taskId}-run`,
    taskId,
    taskVersion,
    trials,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: {
      total: samples.length,
      trials,
      ...(meanPassRate === undefined ? {} : { meanPassRate }),
      ...(meanPassRate === undefined ? { noQualitySignal: true as const } : {}),
      infraErrorRate: plannedTrials === 0 ? 0 : infraErrors / plannedTrials,
      stddevPassRate: 0,
      passRateCI: makeCI(meanPassRate ?? 0),
    },
    samples,
    rawRuns: [],
  };
}

function makeBaseline(taskId: string, opts: { model?: string; taskVersion?: string } = {}): Baseline {
  return {
    schemaVersion: 1,
    taskId,
    taskVersion: opts.taskVersion ?? "1.0.0",
    ...(opts.model === undefined ? {} : { model: opts.model }),
    createdAt: "2025-01-01T00:00:00.000Z",
    samples: [
      {
        sampleId: "s1",
        passRate: 0.9,
        trials: 10,
        nonErrorTrials: 10,
        infraErrorCount: 0,
        passCount: 9,
      },
    ],
  };
}

describe("iter16 F15 — RegressionDetector model drift", () => {
  it("rejects by default when baseline.model differs from current.model", () => {
    const detector = new RegressionDetector({ alpha: 0.05 });
    const baseline = makeBaseline("t1", { model: "gpt-5" });
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)], { model: "claude-opus" });
    expect(() => detector.detect(baseline, current)).toThrowError(/model/);
  });

  it("accepts when allowModelDrift: true", () => {
    const detector = new RegressionDetector({ alpha: 0.05, allowModelDrift: true });
    const baseline = makeBaseline("t1", { model: "gpt-5" });
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)], { model: "claude-opus" });
    expect(() => detector.detect(baseline, current)).not.toThrow();
  });

  it("accepts when both sides' model is undefined (legacy compat)", () => {
    const detector = new RegressionDetector({ alpha: 0.05 });
    const baseline = makeBaseline("t1");
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    expect(() => detector.detect(baseline, current)).not.toThrow();
  });

  it("accepts when only baseline.model is undefined", () => {
    const detector = new RegressionDetector({ alpha: 0.05 });
    const baseline = makeBaseline("t1");
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)], { model: "claude-opus" });
    expect(() => detector.detect(baseline, current)).not.toThrow();
  });

  it("accepts when only current.model is undefined", () => {
    const detector = new RegressionDetector({ alpha: 0.05 });
    const baseline = makeBaseline("t1", { model: "gpt-5" });
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    expect(() => detector.detect(baseline, current)).not.toThrow();
  });

  it("accepts when models match", () => {
    const detector = new RegressionDetector({ alpha: 0.05 });
    const baseline = makeBaseline("t1", { model: "gpt-5" });
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)], { model: "gpt-5" });
    expect(() => detector.detect(baseline, current)).not.toThrow();
  });
});
