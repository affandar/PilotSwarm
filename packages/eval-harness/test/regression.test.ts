import { describe, it, expect, vi } from "vitest";

import { RegressionDetector } from "../src/regression.js";
import type { Baseline, MultiTrialResult, SampleTrialResult } from "../src/types.js";

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
    wilsonCI: { lower: Math.max(0, (passRate ?? 0) - 0.1), upper: Math.min(1, (passRate ?? 0) + 0.1), point: passRate ?? 0, z: 1.96 },
  };
}

function makeMultiTrial(
  taskId: string,
  taskVersion: string,
  trials: number,
  samples: SampleTrialResult[],
): MultiTrialResult {
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
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: {
      total: samples.length,
      trials,
      ...(meanPassRate === undefined ? {} : { meanPassRate }),
      ...(meanPassRate === undefined ? { noQualitySignal: true as const } : {}),
      infraErrorRate: plannedTrials === 0 ? 0 : infraErrors / plannedTrials,
      stddevPassRate: 0,
      passRateCI: { lower: Math.max(0, (meanPassRate ?? 0) - 0.1), upper: Math.min(1, (meanPassRate ?? 0) + 0.1), point: meanPassRate ?? 0, z: 1.96 },
    },
    samples,
    rawRuns: [],
  };
}

function makeBaseline(taskId: string, taskVersion: string): Baseline {
  return {
    schemaVersion: 1,
    taskId,
    taskVersion,
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

describe("RegressionDetector — F14 taskVersion compatibility", () => {
  it("throws when baseline.taskVersion differs from current.taskVersion (default)", () => {
    const detector = new RegressionDetector();
    const baseline = makeBaseline("task-a", "1.0.0");
    const current = makeMultiTrial("task-a", "2.0.0", 10, [makeSample("s1", 9, 10)]);

    expect(() => detector.detect(baseline, current)).toThrow(
      /baseline taskVersion '1\.0\.0' does not match current taskVersion '2\.0\.0'/,
    );
    expect(() => detector.detect(baseline, current)).toThrow(/allowVersionDrift/);
  });

  it("warns and proceeds when allowVersionDrift: true", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detector = new RegressionDetector({ alpha: 0.05, allowVersionDrift: true });
    const baseline = makeBaseline("task-a", "1.0.0");
    const current = makeMultiTrial("task-a", "2.0.0", 10, [makeSample("s1", 9, 10)]);

    try {
      const result = detector.detect(baseline, current);
      expect(result.regressions).toHaveLength(1);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
        /taskVersion.*1\.0\.0.*2\.0\.0/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not throw when taskVersion matches", () => {
    const detector = new RegressionDetector();
    const baseline = makeBaseline("task-a", "1.0.0");
    const current = makeMultiTrial("task-a", "1.0.0", 10, [makeSample("s1", 9, 10)]);
    const result = detector.detect(baseline, current);
    expect(result.regressions).toHaveLength(1);
  });

  it("still throws on taskId mismatch independently of version drift opt-in", () => {
    const detector = new RegressionDetector({ alpha: 0.05, allowVersionDrift: true });
    const baseline = makeBaseline("task-a", "1.0.0");
    const current = makeMultiTrial("task-b", "1.0.0", 10, [makeSample("s1", 9, 10)]);
    expect(() => detector.detect(baseline, current)).toThrow(/taskId/);
  });
});
