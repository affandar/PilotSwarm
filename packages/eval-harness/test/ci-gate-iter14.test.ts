import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CIGate } from "../src/ci-gate.js";
import { RegressionDetector } from "../src/regression.js";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import type {
  Baseline,
  MultiTrialResult,
  SampleTrialResult,
  RegressionDetectionResult,
  EvalTask,
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
  taskVersion = "1.0.0",
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
      passRateCI: makeCI(meanPassRate ?? 0),
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
      {
        sampleId: "s2",
        passRate: 0.8,
        trials: 10,
        nonErrorTrials: 10,
        infraErrorCount: 0,
        passCount: 8,
      },
    ],
  };
}

describe("iter14 F11 — CIGate schema-validate-first", () => {
  it("returns pass:false instead of throwing when result lacks summary", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    // Intentionally broken: missing required `summary` field
    const broken = {
      schemaVersion: 1,
      runId: "x",
      taskId: "t1",
      taskVersion: "1.0.0",
      trials: 1,
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z",
      samples: [],
      rawRuns: [],
    } as unknown as MultiTrialResult;

    let result;
    expect(() => {
      result = gate.evaluate(broken);
    }).not.toThrow();
    expect(result!.pass).toBe(false);
    expect(
      result!.reasons.some((r) => /MultiTrialResult failed schema validation/.test(r)),
    ).toBe(true);
  });

  it("returns pass:false instead of throwing when samples is missing", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const broken = {
      schemaVersion: 1,
      runId: "x",
      taskId: "t1",
      taskVersion: "1.0.0",
      trials: 1,
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z",
      summary: {
        total: 0,
        trials: 1,
        infraErrorRate: 0,
        stddevPassRate: 0,
        passRateCI: makeCI(0),
        noQualitySignal: true,
      },
      rawRuns: [],
    } as unknown as MultiTrialResult;

    expect(() => gate.evaluate(broken)).not.toThrow();
    const r = gate.evaluate(broken);
    expect(r.pass).toBe(false);
  });
});

describe("iter14 F12 — failOnNewSamples / allowMissingBaselineSamples + missing regression", () => {
  it("fails closed when failOnNewSamples is true (default) and regression undefined", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((reason) =>
        reason.includes("failOnNewSamples configured but regression data not provided"),
      ),
    ).toBe(true);
  });

  it("does NOT fail-close when both failOnNewSamples:false and allowMissingBaselineSamples:true", () => {
    const gate = new CIGate({
      passRateFloor: 0.5,
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
    });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(true);
    expect(
      r.reasons.some((reason) =>
        reason.includes("failOnNewSamples configured but regression data not provided"),
      ),
    ).toBe(false);
  });
});

describe("iter14 F18 — passRateFloor precedence (config > task > error)", () => {
  it("uses task.passRateFloor when config.passRateFloor is unset", () => {
    const gate = new CIGate({
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
    });
    const task: Partial<EvalTask> = { passRateFloor: 0.8 };
    const passResult = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]); // 0.9 >= 0.8
    const failResult = makeMultiTrial("t2", 10, [makeSample("s1", 7, 10)]); // 0.7 < 0.8

    const passVerdict = gate.evaluate(passResult, undefined, undefined, task);
    expect(passVerdict.pass).toBe(true);

    const failVerdict = gate.evaluate(failResult, undefined, undefined, task);
    expect(failVerdict.pass).toBe(false);
    expect(
      failVerdict.reasons.some((r) => /below floor 80\.0%/.test(r)),
    ).toBe(true);
  });

  it("config.passRateFloor wins over task.passRateFloor", () => {
    const gate = new CIGate({
      passRateFloor: 0.5,
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
    });
    const task: Partial<EvalTask> = { passRateFloor: 0.95 };
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 7, 10)]); // 0.7 >= 0.5 but < 0.95

    const r = gate.evaluate(result, undefined, undefined, task);
    expect(r.pass).toBe(true); // gate uses 0.5 not 0.95
  });

  it("falls back to QUALITY_GATE_REQUIRED when neither is set", () => {
    const gate = new CIGate({
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
    });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);

    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((reason) => reason.includes("CIGate requires passRateFloor"))).toBe(true);
  });
});

describe("iter14 F1 — noQualityCurrentSamples integration", () => {
  it("RegressionDetector skips current no-quality samples and reports them in noQualityCurrentSamples", () => {
    const detector = new RegressionDetector();
    const baseline = makeBaseline("task-a", "1.0.0");
    const current = makeMultiTrial("task-a", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 0, 10, 10), // all infra errors → noQualitySignal
    ]);

    const detection = detector.detect(baseline, current);

    expect(detection.regressions.map((r) => r.sampleId)).toEqual(["s1"]);
    expect(detection.noQualityCurrentSamples).toEqual(["s2"]);
  });

  it("CIGate.evaluate fails with infra-outage reason for noQualityCurrentSamples (not a forged 0% regression)", () => {
    const gate = new CIGate({
      passRateFloor: 0.5,
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
    });
    const detection: RegressionDetectionResult = {
      regressions: [],
      missingBaselineSamples: [],
      newCurrentSamples: [],
      noQualityCurrentSamples: ["s2"],
    };
    const current = makeMultiTrial("task-a", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 0, 10, 10),
    ]);

    const r = gate.evaluate(current, detection);
    expect(r.pass).toBe(false);
    // Should not synthesize a regression entry
    expect(r.regressionCount ?? 0).toBe(0);
    // Should report no-quality-signal explicitly
    expect(
      r.reasons.some((reason) => /no quality signal/.test(reason)),
    ).toBe(true);
  });

  it("PRCommentReporter renders noQualityCurrentSamples in a distinct section, not as 0% regressions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-iter14-"));
    const out = join(dir, "pr.md");
    const reporter = new PRCommentReporter(out);

    try {
      reporter.writeGateResult(
        {
          pass: false,
          reasons: ["infra outage: 1 sample(s) had no quality signal: s2"],
          passRate: 0.9,
        },
        [],
        { noQualityCurrentSamples: ["s2"] },
      );

      const md = readFileSync(out, "utf8");
      expect(md).toMatch(/No Quality Signal/i);
      expect(md).toMatch(/s2/);
      // Must NOT render as a 0% regression row
      expect(md).not.toMatch(/\| s2 \|.*0\.0%.*0\.0%/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CIGate.evaluate passes through silently when requireNoInfraOutage:false even with noQualityCurrentSamples", () => {
    const gate = new CIGate({
      passRateFloor: 0.5,
      failOnNewSamples: false,
      allowMissingBaselineSamples: true,
      requireNoInfraOutage: false,
    });
    const detection: RegressionDetectionResult = {
      regressions: [],
      missingBaselineSamples: [],
      newCurrentSamples: [],
      noQualityCurrentSamples: ["s2"],
    };
    // Provide one good sample so passRateFloor passes
    const current = makeMultiTrial("task-a", 10, [makeSample("s1", 9, 10)]);

    const r = gate.evaluate(current, detection);
    // No fabricated regression
    expect(r.regressionCount ?? 0).toBe(0);
    expect(r.pass).toBe(true);
  });
});
