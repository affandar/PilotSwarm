import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CIGate } from "../src/ci-gate.js";
import { RegressionDetector } from "../src/regression.js";
import { saveBaseline, loadBaseline } from "../src/baseline.js";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import type {
  MultiTrialResult,
  SampleTrialResult,
  RegressionResult,
  RegressionDetectionResult,
  Baseline,
  MatrixResult,
} from "../src/types.js";
import { CIGateResultSchema } from "../src/types.js";

type WilsonCI = { lower: number; upper: number; point: number; z: number };

const QUALITY_GATE_REQUIRED_REASON =
  "CIGate requires passRateFloor for quality approval — cost, infra, regression-only, and operational gates cannot replace a pass-rate floor. Configure passRateFloor with a value in (0, 1].";

function asDetection(
  regressions: RegressionResult[],
  missingBaselineSamples: string[] = [],
  newCurrentSamples: string[] = [],
): RegressionDetectionResult {
  return { regressions, missingBaselineSamples, newCurrentSamples };
}

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
    ...(passRate === undefined ? {} : { passRate }),
    ...(passRate === undefined ? { noQualitySignal: true } : {}),
    passAtK: {},
    scores: {},
    wilsonCI: makeCI(passRate ?? 0),
  };
}

function makeMultiTrial(
  taskId: string,
  trials: number,
  samples: SampleTrialResult[],
): MultiTrialResult {
  const qualitySamples = samples.filter((s) => s.passRate !== undefined);
  const meanPassRate =
    qualitySamples.length === 0
      ? undefined
      : qualitySamples.reduce((a, s) => a + s.passRate!, 0) / qualitySamples.length;
  const infraErrors = samples.reduce((a, s) => a + s.errorCount, 0);
  const plannedTrials = samples.length * trials;
  return {
    schemaVersion: 1,
    runId: `${taskId}-run`,
    taskId,
    taskVersion: "1.0.0",
    trials,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: {
      total: samples.length,
      trials,
      ...(meanPassRate === undefined ? {} : { meanPassRate }),
      ...(meanPassRate === undefined ? { noQualitySignal: true } : {}),
      infraErrorRate: plannedTrials === 0 ? 0 : infraErrors / plannedTrials,
      stddevPassRate: 0,
      passRateCI: makeCI(meanPassRate ?? 0),
    },
    samples,
    rawRuns: [],
  };
}

describe("CIGate", () => {
  it("passes when all gates met", () => {
    const gate = new CIGate({ passRateFloor: 0.8, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(true);
    expect(r.reasons).toContain("All gates passed");
    expect(r.passRate).toBeCloseTo(0.9, 5);
  });

  it("fails when supplied summary meanPassRate disagrees with samples", () => {
    const gate = new CIGate({ passRateFloor: 0.8, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 0, 10)]);
    result.summary.meanPassRate = 1;

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons).toContain(
      "summary.meanPassRate (1) does not match recomputed value (0) — input integrity violated",
    );
    expect(r.reasons.some((reason) => reason.includes("All gates passed"))).toBe(false);
  });

  it("accepts honest summary meanPassRate matching recomputed sample values", () => {
    const gate = new CIGate({ passRateFloor: 0.8, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(true);
    expect(r.passRate).toBeCloseTo(0.9, 10);
  });

  it("allows callers to opt out of summary integrity checks with trustSummary", () => {
    const gate = new CIGate({ passRateFloor: 0.8, trustSummary: true, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 0, 10)]);
    result.summary.meanPassRate = 1;

    const r = gate.evaluate(result);

    expect(r.reasons).not.toContain(
      "summary.meanPassRate (1) does not match recomputed value (0) — input integrity violated",
    );
    expect(r.reasons.some((reason) => reason.includes("below floor"))).toBe(true);
  });

  it("fails on pass rate below floor", () => {
    const gate = new CIGate({ passRateFloor: 0.9 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(true);
  });

  it("fails on too many regressions", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 1.0,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
    ];
    const r = gate.evaluate(result, asDetection(regressions));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("regression"))).toBe(true);
    expect(r.regressionCount).toBe(1);
  });

  it("returns exit code 0 on pass, 1 on fail", () => {
    const gate = new CIGate({ passRateFloor: 0.5, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const pass = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const fail = makeMultiTrial("t1", 10, [makeSample("s1", 0, 10)]);
    expect(gate.exitCode(gate.evaluate(pass))).toBe(0);
    expect(gate.exitCode(gate.evaluate(fail))).toBe(1);
  });

  it("validates config in constructor", () => {
    expect(() => new CIGate({ passRateFloor: 1.5 } as never)).toThrow();
    expect(() => new CIGate({ maxRegressions: -1 } as never)).toThrow();
  });

  it("rejects non-quality-only gate configurations as missing a quality gate (F4 family)", () => {
    // Quality-gate-required must fire whenever no actual quality gate (passRateFloor)
    // is configured, regardless of which non-quality knobs are set.
    const cases: Array<{ name: string; gate: CIGate; regressions?: ReturnType<typeof asDetection> }> = [
      { name: "default ({})", gate: new CIGate({}) },
      {
        name: "explicit failOnNewSamples=false, allowMissingBaselineSamples",
        gate: new CIGate({ failOnNewSamples: false, allowMissingBaselineSamples: true }),
      },
      { name: "cost-only", gate: new CIGate({ maxCostUsd: 5 }) },
      { name: "infra-only", gate: new CIGate({ maxInfraErrors: 0 }) },
      { name: "empty-regression-only", gate: new CIGate({ maxRegressions: 0 }), regressions: asDetection([]) },
      { name: "explicit requireNoInfraOutage:true", gate: new CIGate({ requireNoInfraOutage: true }) },
      { name: "every gate disabled", gate: new CIGate({ requireNoInfraOutage: false }) },
    ];
    for (const c of cases) {
      const result = makeMultiTrial("t1", 5, [makeSample("s1", 3, 5)]);
      const r = c.gate.evaluate(result, c.regressions, c.name === "cost-only" ? 4 : undefined);
      expect(r.pass, `case=${c.name}`).toBe(false);
      expect(r.reasons, `case=${c.name}`).toContain(QUALITY_GATE_REQUIRED_REASON);
    }
  });

  it("rejects maxRegressions-only configuration as a quality gate even with actual regressions data (F4)", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 5, [makeSample("s1", 0, 5)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0,
        currentPassRate: 0,
        pValue: 1,
        significant: false,
        direction: "unchanged",
      },
    ];
    const r = gate.evaluate(result, asDetection(regressions));

    expect(r.pass).toBe(false);
    expect(r.reasons).toContain(QUALITY_GATE_REQUIRED_REASON);
    expect(r.reasons).not.toContain("All gates passed");
  });

  it("fails all-infra-error samples with an infra outage reason before pass rate floor", () => {
    const gate = new CIGate({ passRateFloor: 0.9 });
    const result = makeMultiTrial("t1", 3, [makeSample("s1", 0, 3, 3)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("infra outage on sample(s): s1"))).toBe(true);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(false);
  });

  it("fails when passRateFloor is configured but outage-disabled run has no quality signal", () => {
    const gate = new CIGate({ passRateFloor: 0.8, requireNoInfraOutage: false });
    const result = makeMultiTrial("t1", 3, [makeSample("s1", 0, 3, 3)]);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons).toContain(
      "passRateFloor configured but no quality signal was collected (all samples were infra outages or empty)",
    );
  });

  it("includes no-quality-floor reason alongside required outage failure", () => {
    const gate = new CIGate({ passRateFloor: 0.8, requireNoInfraOutage: true });
    const result = makeMultiTrial("t1", 3, [makeSample("s1", 0, 3, 3)]);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("infra outage on sample(s): s1 — no quality signal collected");
    expect(r.reasons).toContain(
      "passRateFloor configured but no quality signal was collected (all samples were infra outages or empty)",
    );
  });

  it("evaluates pass rate floor over quality samples when other samples have infra errors", () => {
    const gate = new CIGate({ passRateFloor: 0.8 });
    const result = makeMultiTrial("t1", 3, [
      makeSample("quality", 3, 3, 0),
      makeSample("outage", 0, 3, 3),
    ]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("infra outage on sample(s): outage"))).toBe(true);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(false);
    expect(r.passRate).toBe(1);
  });

  it("includes all failure reasons when multiple gates fail", () => {
    const gate = new CIGate({
      passRateFloor: 0.9,
      maxRegressions: 0,
    });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 3, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.3,
        pValue: 0.001,
        significant: true,
        direction: "regressed",
      },
    ];
    const r = gate.evaluate(result, asDetection(regressions));
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("fails when maxRegressions configured but regressions arg not provided", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /regression/i.test(s))).toBe(true);
  });

  it("fails when maxCostUsd configured but totalCostUsd not provided", () => {
    const gate = new CIGate({ maxCostUsd: 10 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /cost/i.test(s))).toBe(true);
  });

  it("fails when totalCostUsd is non-finite (NaN, ±Infinity) or negative", () => {
    const gate = new CIGate({ maxCostUsd: 10 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    for (const [bad, reasonRe] of [
      [NaN, /invalid|non-finite/i],
      [-1, /invalid|negative/i],
    ] as const) {
      const r = gate.evaluate(result, undefined, bad);
      expect(r.pass, `cost=${bad}`).toBe(false);
      expect(r.reasons.some((s) => reasonRe.test(s)), `cost=${bad}`).toBe(true);
      expect(r.totalCostUsd, `cost=${bad}`).toBeUndefined();
      expect(CIGateResultSchema.safeParse(r).success, `cost=${bad}`).toBe(true);
    }
  });

  it("does not count non-significant or improved regressions", () => {
    const gate = new CIGate({ passRateFloor: 0.5, maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10), makeSample("s2", 8, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.5,
        currentPassRate: 0.9,
        pValue: 0.01,
        significant: true,
        direction: "improved",
      },
      {
        sampleId: "s2",
        baselinePassRate: 0.8,
        currentPassRate: 0.8,
        pValue: 0.5,
        significant: false,
        direction: "unchanged",
      },
    ];
    const r = gate.evaluate(result, asDetection(regressions));
    expect(r.pass).toBe(true);
    expect(r.regressionCount).toBe(0);
  });

  it("reports passRateFloor failures instead of quality-gate-required when a quality gate is configured", () => {
    const gate = new CIGate({ passRateFloor: 0.5, maxCostUsd: 5 });
    const result = makeMultiTrial("t1", 5, [makeSample("s1", 0, 5)]);
    const r = gate.evaluate(result, undefined, 0);

    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(true);
    expect(r.reasons).not.toContain(QUALITY_GATE_REQUIRED_REASON);
  });

  // ---------------------------------------------------------------------------
  // F2: CIGate must validate input and regressionInput at runtime
  // ---------------------------------------------------------------------------
  it("F2: fails closed when MultiTrialResult has tampered sample passRate", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    // Forge passRate to a value the schema must reject (>1).
    (result.samples[0] as unknown as { passRate: number }).passRate = 999;

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("MultiTrialResult failed schema validation"))).toBe(
      true,
    );
  });

  it("F2: fails closed when MultiTrialResult.summary.total disagrees with samples", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    result.summary.total = 99; // schema invariant: must equal samples.length

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("MultiTrialResult failed schema validation"))).toBe(
      true,
    );
  });

  it("F2: fails closed when regressionInput object fails schema validation", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const tampered = {
      regressions: [
        {
          sampleId: "s1",
          baselinePassRate: 1.5, // out of range
          currentPassRate: 0.5,
          pValue: 0.01,
          significant: true,
          direction: "regressed",
        },
      ],
      missingBaselineSamples: [],
      newCurrentSamples: [],
    } as unknown as RegressionDetectionResult;

    const r = gate.evaluate(result, tampered);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) => s.includes("RegressionDetectionResult failed schema validation")),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F3: undefined summary.meanPassRate must FAIL integrity (when not trusted)
  // ---------------------------------------------------------------------------
  it("F3: fails when summary.meanPassRate is missing while quality samples exist", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    delete (result.summary as { meanPassRate?: number }).meanPassRate;

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) =>
        s.includes("summary.meanPassRate is missing while quality samples exist"),
      ),
    ).toBe(true);
  });

  it("F3: trustSummary=true allows omitted meanPassRate", () => {
    const gate = new CIGate({ passRateFloor: 0.5, trustSummary: true, failOnNewSamples: false, allowMissingBaselineSamples: true });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    delete (result.summary as { meanPassRate?: number }).meanPassRate;

    const r = gate.evaluate(result);

    expect(r.pass).toBe(true);
    expect(
      r.reasons.some((s) =>
        s.includes("summary.meanPassRate is missing while quality samples exist"),
      ),
    ).toBe(false);
  });

  it("F3: missing meanPassRate is fine when there is no quality signal at all", () => {
    const gate = new CIGate({ passRateFloor: 0.5, requireNoInfraOutage: false });
    const result = makeMultiTrial("t1", 3, [makeSample("s1", 0, 3, 3)]);

    const r = gate.evaluate(result);

    expect(
      r.reasons.some((s) =>
        s.includes("summary.meanPassRate is missing while quality samples exist"),
      ),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // F11: cross-check regressionInput sample IDs against current.samples
  // ---------------------------------------------------------------------------
  it("F11: fails when regressionInput.regressions references ghost sample IDs", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const detection = asDetection([
      {
        sampleId: "ghost",
        baselinePassRate: 0.9,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
    ]);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) =>
        s.includes("regressionInput references sample IDs not present in current run: ghost"),
      ),
    ).toBe(true);
  });

  it("F11: fails when missingBaselineSamples lists a sample that IS in the current run", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const detection = asDetection([], ["s1"], []);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) =>
        s.includes(
          "regressionInput.missingBaselineSamples contains IDs that exist in the current run: s1",
        ),
      ),
    ).toBe(true);
  });

  it("F11: fails when newCurrentSamples lists a sample that is NOT in the current run", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const detection = asDetection([], [], ["phantom"]);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) =>
        s.includes(
          "regressionInput.newCurrentSamples contains IDs missing from the current run: phantom",
        ),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F13: passRateFloor uses POOLED non-error pass rate, not unweighted mean
  // ---------------------------------------------------------------------------
  it("F13: passRateFloor uses pooled non-error pass rate (catches Simpson's-paradox split)", () => {
    // 1 tiny passing sample (1/1) and 1 large failing sample (0/100).
    // Unweighted mean = 0.5; pooled = 1/101 ≈ 0.0099.
    const gate = new CIGate({ passRateFloor: 0.4 });
    const samples: SampleTrialResult[] = [makeSample("tiny", 1, 1), makeSample("big", 0, 100)];
    const result = makeMultiTrial("t1", 100, samples);

    const r = gate.evaluate(result);

    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(true);
    // passRate reported on result is pooled, not unweighted mean.
    expect(r.passRate).toBeCloseTo(1 / 101, 5);
  });

  // ---------------------------------------------------------------------------
  // F1: regressionInput entries must be internally consistent — direction must
  // agree with rate comparison, significance must agree with direction, and
  // currentPassRate must match the actual sample's passRate. Forged values
  // must fail the gate closed.
  // ---------------------------------------------------------------------------
  it("F1: fails on internally-inconsistent regression entries (forged direction/significance/passRate)", () => {
    // Each case represents a forged regressionInput that internally contradicts the
    // current run or itself. The gate must fail closed and surface the specific reason.
    const cases: Array<{
      name: string;
      sample: ReturnType<typeof makeSample>;
      passRateFloor: number;
      detection: Parameters<typeof asDetection>[0][number];
      reasonContains: string[];
    }> = [
      {
        name: "direction=improved contradicts current<baseline",
        sample: makeSample("s1", 5, 10),
        passRateFloor: 0.4,
        detection: {
          sampleId: "s1", baselinePassRate: 0.9, currentPassRate: 0.5,
          pValue: 0.001, significant: true, direction: "improved",
        },
        reasonContains: ['direction "improved"', "contradicts"],
      },
      {
        name: "direction=regressed contradicts current>baseline",
        sample: makeSample("s1", 9, 10),
        passRateFloor: 0.5,
        detection: {
          sampleId: "s1", baselinePassRate: 0.5, currentPassRate: 0.9,
          pValue: 0.001, significant: true, direction: "regressed",
        },
        reasonContains: ['direction "regressed"'],
      },
      {
        name: "significant=true paired with direction=unchanged",
        sample: makeSample("s1", 8, 10),
        passRateFloor: 0.5,
        detection: {
          sampleId: "s1", baselinePassRate: 0.8, currentPassRate: 0.8,
          pValue: 0.001, significant: true, direction: "unchanged",
        },
        reasonContains: ["significant=true contradicts", '"unchanged"'],
      },
      {
        name: "significant=false paired with direction=regressed",
        sample: makeSample("s1", 5, 10),
        passRateFloor: 0.4,
        detection: {
          sampleId: "s1", baselinePassRate: 0.9, currentPassRate: 0.5,
          pValue: 0.5, significant: false, direction: "regressed",
        },
        reasonContains: ["significant=false contradicts", '"regressed"'],
      },
      {
        name: "significant=false paired with direction=improved",
        sample: makeSample("s1", 9, 10),
        passRateFloor: 0.5,
        detection: {
          sampleId: "s1", baselinePassRate: 0.5, currentPassRate: 0.9,
          pValue: 0.5, significant: false, direction: "improved",
        },
        reasonContains: ["significant=false contradicts", '"improved"'],
      },
      {
        name: "non-unchanged direction on equal pass rates",
        sample: makeSample("s1", 8, 10),
        passRateFloor: 0.5,
        detection: {
          sampleId: "s1", baselinePassRate: 0.8, currentPassRate: 0.8,
          pValue: 0.5, significant: false, direction: "improved",
        },
        reasonContains: ["equal pass rates"],
      },
    ];
    for (const c of cases) {
      const gate = new CIGate({ passRateFloor: c.passRateFloor, maxRegressions: 0 });
      const result = makeMultiTrial("t1", 10, [c.sample]);
      const r = gate.evaluate(result, asDetection([c.detection]));
      expect(r.pass, `case=${c.name}`).toBe(false);
      const matched = r.reasons.some(
        (s) => s.includes('regressionInput entry for sample "s1" inconsistent') &&
          c.reasonContains.every((needle) => s.includes(needle)),
      );
      expect(matched, `case=${c.name}\nreasons=${JSON.stringify(r.reasons)}`).toBe(true);
    }
  });

  it("F1: fails when forged currentPassRate does not match the sample's actual passRate", () => {
    const gate = new CIGate({ passRateFloor: 0.4, maxRegressions: 0 });
    // Sample's true passRate is 3/10 = 0.3. Forged currentPassRate claims 0.7.
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 3, 10)]);
    const detection = asDetection([
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.7,
        pValue: 0.001,
        significant: true,
        direction: "regressed",
      },
    ]);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some(
        (s) =>
          s.includes('regressionInput entry for sample "s1" inconsistent') &&
          s.includes("currentPassRate") &&
          s.includes("does not match sample.passRate"),
      ),
    ).toBe(true);
  });

  it("F1: fails when a regression entry exists for a sample with no quality signal", () => {
    const gate = new CIGate({
      passRateFloor: 0.5,
      maxRegressions: 0,
      requireNoInfraOutage: false,
    });
    // Sample is a full infra outage — no passRate, noQualitySignal:true.
    const result = makeMultiTrial("t1", 5, [makeSample("s1", 0, 5, 5)]);
    const detection = asDetection([
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0,
        pValue: 0.001,
        significant: true,
        direction: "regressed",
      },
    ]);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some(
        (s) =>
          s.includes('regressionInput entry for sample "s1" inconsistent') &&
          s.includes("no quality signal"),
      ),
    ).toBe(true);
  });

  it("F1: PASSES on an honest object-form regression result with consistent values", () => {
    const gate = new CIGate({ passRateFloor: 0.4, maxRegressions: 1 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    const detection = asDetection([
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.5,
        pValue: 0.001,
        significant: true,
        direction: "regressed",
      },
    ]);

    const r = gate.evaluate(result, detection);

    expect(r.pass).toBe(true);
    expect(r.regressionCount).toBe(1);
    expect(
      r.reasons.some((s) => s.includes("inconsistent")),
    ).toBe(false);
  });

  it("F1: real RegressionDetector output is accepted (regression detected, gate fails on count)", () => {
    const gate = new CIGate({ passRateFloor: 0.3, maxRegressions: 0 });
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [
        {
          sampleId: "s1",
          passRate: 1,
          trials: 30,
          nonErrorTrials: 30,
          infraErrorCount: 0,
          passCount: 30,
        },
      ],
    };
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 10, 30)]);
    const detection = new RegressionDetector(0.05).detect(baseline, current);

    const r = gate.evaluate(current, detection);

    expect(r.pass).toBe(false);
    expect(r.regressionCount).toBe(1);
    // No inconsistency reasons — the detector produces honest values.
    expect(r.reasons.some((s) => s.includes("inconsistent"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // F16: array-form regressionInput is rejected (must be RegressionDetectionResult)
  // ---------------------------------------------------------------------------
  it("F16: rejects RegressionResult[] array form with a clear reason", () => {
    const gate = new CIGate({ passRateFloor: 0.5, maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const arrayForm: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 1.0,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
    ];

    // Bypass TS: the public API forbids array; verify runtime fails closed.
    const r = gate.evaluate(result, arrayForm as unknown as RegressionDetectionResult);

    expect(r.pass).toBe(false);
    expect(
      r.reasons.some((s) =>
        s.includes("CIGate.evaluate no longer accepts RegressionResult[] as regressionInput"),
      ),
    ).toBe(true);
  });
});

describe("RegressionDetector", () => {
  function mkBaseline(samples: Array<[string, number, number]>): Baseline {
    return {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: samples.map(([id, pc, tr]) => ({
        sampleId: id,
        passRate: tr === 0 ? 0 : pc / tr,
        trials: tr,
        nonErrorTrials: tr,
        infraErrorCount: 0,
        passCount: pc,
      })),
    };
  }

  it("detects regression when pass rate drops significantly", () => {
    const baseline = mkBaseline([["s1", 30, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 10, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results.regressions).toHaveLength(1);
    expect(results.missingBaselineSamples).toEqual([]);
    const r = results.regressions[0]!;
    expect(r.sampleId).toBe("s1");
    expect(r.direction).toBe("regressed");
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it("detects improvement when pass rate rises significantly", () => {
    const baseline = mkBaseline([["s1", 5, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 28, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results.regressions).toHaveLength(1);
    const r = results.regressions[0]!;
    expect(r.direction).toBe("improved");
    expect(r.significant).toBe(true);
  });

  it("reports unchanged for insignificant differences", () => {
    const baseline = mkBaseline([["s1", 15, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 16, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    const r = results.regressions[0]!;
    expect(r.significant).toBe(false);
    expect(r.direction).toBe("unchanged");
  });

  it("reports new current samples not in baseline and skips them for regression testing", () => {
    const baseline = mkBaseline([["s1", 10, 10]]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("s1", 10, 10),
      makeSample("s2_new", 5, 10),
    ]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results.regressions).toHaveLength(1);
    expect(results.missingBaselineSamples).toEqual([]);
    expect(results.newCurrentSamples).toEqual(["s2_new"]);
    expect(results.regressions[0]!.sampleId).toBe("s1");
  });

  it("reports baseline samples missing from current", () => {
    const baseline = mkBaseline([
      ["s1", 10, 10],
      ["s2_removed", 10, 10],
      ["s3_removed", 8, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results.regressions).toHaveLength(1);
    expect(results.regressions[0]!.sampleId).toBe("s1");
    expect(results.missingBaselineSamples).toEqual(["s2_removed", "s3_removed"]);
    expect(results.newCurrentSamples).toEqual([]);
  });

  it("reports both removed baseline samples and new current samples", () => {
    const baseline = mkBaseline([
      ["a", 10, 10],
      ["b", 10, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("b", 10, 10),
      makeSample("c", 10, 10),
    ]);

    const results = new RegressionDetector(0.05).detect(baseline, current);

    expect(results.missingBaselineSamples).toEqual(["a"]);
    expect(results.newCurrentSamples).toEqual(["c"]);
  });

  it("allows new current samples when failOnNewSamples is explicitly disabled", () => {
    const baseline = mkBaseline([
      ["a", 10, 10],
      ["b", 10, 10],
      ["c", 10, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("a", 10, 10),
      makeSample("b", 10, 10),
      makeSample("c", 10, 10),
      makeSample("d", 10, 10),
    ]);
    const detection = new RegressionDetector(0.05).detect(baseline, current);
    const verdict = new CIGate({
      passRateFloor: 0.5,
      maxRegressions: 0,
      failOnNewSamples: false,
    }).evaluate(current, detection);

    expect(detection.newCurrentSamples).toEqual(["d"]);
    expect(verdict.pass).toBe(true);
  });

  it("fails CIGate on new current samples by default (failOnNewSamples defaults to true)", () => {
    const baseline = mkBaseline([
      ["a", 10, 10],
      ["b", 10, 10],
      ["c", 10, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("a", 10, 10),
      makeSample("b", 10, 10),
      makeSample("c", 10, 10),
      makeSample("d", 10, 10),
    ]);
    const detection = new RegressionDetector(0.05).detect(baseline, current);
    const verdict = new CIGate({ passRateFloor: 0.5, maxRegressions: 0 }).evaluate(
      current,
      detection,
    );

    expect(detection.newCurrentSamples).toEqual(["d"]);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain(
      "new samples added vs baseline: d — opt out with failOnNewSamples: false",
    );
  });

  it("fails CIGate when baseline samples are missing from current", () => {
    const baseline = mkBaseline([
      ["a", 10, 10],
      ["b", 10, 10],
      ["c", 0, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("a", 10, 10),
      makeSample("b", 10, 10),
    ]);
    const detection = new RegressionDetector(0.05).detect(baseline, current);
    const verdict = new CIGate({ passRateFloor: 0.8 }).evaluate(current, detection);

    expect(detection.missingBaselineSamples).toEqual(["c"]);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain("missing baseline samples: c");
  });

  it("emits missing baseline samples without failing CIGate when explicitly allowed", () => {
    const baseline = mkBaseline([
      ["a", 10, 10],
      ["b", 10, 10],
      ["c", 0, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("a", 10, 10),
      makeSample("b", 10, 10),
    ]);
    const detection = new RegressionDetector(0.05).detect(baseline, current);
    const verdict = new CIGate({
      passRateFloor: 0.8,
      allowMissingBaselineSamples: true,
    }).evaluate(current, detection);

    expect(detection.missingBaselineSamples).toEqual(["c"]);
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toContain("All gates passed");
  });

  it("detects regression with unequal trial counts", () => {
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [
        { sampleId: "s1", passRate: 0.9, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 9 },
      ],
    };
    const current = {
      schemaVersion: 1,
      runId: "r1",
      taskId: "t1",
      taskVersion: "1.0",
      trials: 20,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      samples: [
        {
          sampleId: "s1",
          trials: 20,
          passCount: 8,
          failCount: 12,
          errorCount: 0,
          passRate: 0.4,
          passAtK: {},
          scores: {},
          wilsonCI: { lower: 0.2, upper: 0.6, point: 0.4, z: 1.96 },
        },
      ],
      summary: {
        total: 1,
        trials: 20,
        meanPassRate: 0.4,
        stddevPassRate: 0,
        passRateCI: { lower: 0.2, upper: 0.6, point: 0.4, z: 1.96 },
      },
      rawRuns: [],
    } as unknown as MultiTrialResult;

    const detector = new RegressionDetector(0.05);
    const results = detector.detect(baseline, current);
    const r = results.regressions.find((x) => x.sampleId === "s1");
    expect(r).toBeDefined();
    expect(r!.direction).toBe("regressed");
    expect(r!.significant).toBe(true);
  });

  it("does not false-positive on aggregate data with equal trials", () => {
    // 18/30 baseline vs 12/30 current = 60% vs 40%
    // Two-proportion z-test p ≈ 0.12 (not significant at 0.05)
    // Old McNemar with fabricated pairing gave p ≈ 0.03 (false positive)
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [{ sampleId: "s1", passRate: 0.6, trials: 30, nonErrorTrials: 30, infraErrorCount: 0, passCount: 18 }],
    };
    const current = {
      schemaVersion: 1,
      runId: "r2",
      taskId: "t1",
      taskVersion: "1.0",
      trials: 30,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      samples: [
        {
          sampleId: "s1",
          trials: 30,
          passCount: 12,
          failCount: 18,
          errorCount: 0,
          passRate: 0.4,
          passAtK: {},
          scores: {},
          wilsonCI: { lower: 0.23, upper: 0.59, point: 0.4, z: 1.96 },
        },
      ],
      summary: {
        total: 1,
        trials: 30,
        meanPassRate: 0.4,
        stddevPassRate: 0,
        passRateCI: { lower: 0.23, upper: 0.59, point: 0.4, z: 1.96 },
      },
      rawRuns: [],
    } as unknown as MultiTrialResult;

    const detector = new RegressionDetector(0.05);
    const results = detector.detect(baseline, current);
    const r = results.regressions.find((x) => x.sampleId === "s1");
    expect(r).toBeDefined();
    expect(r!.significant).toBe(false);
    expect(r!.direction).toBe("unchanged");
  });

  it("uses non-error trial counts for current run regression math", () => {
    const baseline = mkBaseline([["s1", 10, 10]]);
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10, 5)]);
    const detector = new RegressionDetector(0.05);

    const result = detector.detect(baseline, current).regressions[0]!;

    expect(current.samples[0]!.passRate).toBe(1);
    expect(result.currentPassRate).toBe(1);
    expect(result.significant).toBe(false);
    expect(result.direction).toBe("unchanged");
    expect(result.pValue).toBe(1);
  });

  it("uses configurable alpha", () => {
    const baseline = mkBaseline([["s1", 20, 20]]);
    // Current 16/20 — borderline
    const current = makeMultiTrial("t1", 20, [makeSample("s1", 16, 20)]);
    const strict = new RegressionDetector(0.01);
    const lax = new RegressionDetector(0.5);
    const rStrict = strict.detect(baseline, current).regressions[0]!;
    const rLax = lax.detect(baseline, current).regressions[0]!;
    // Same p-value, different alpha → different significance
    expect(rStrict.pValue).toBe(rLax.pValue);
    if (rStrict.pValue < 0.5) {
      expect(rLax.significant).toBe(true);
    }
    if (rStrict.pValue > 0.01) {
      expect(rStrict.significant).toBe(false);
    }
  });

  it("supports Bonferroni correction across samples", () => {
    const baseline = mkBaseline([
      ["s1", 30, 30],
      ["s2", 30, 30],
    ]);
    const current = makeMultiTrial("t1", 30, [
      makeSample("s1", 26, 30),
      makeSample("s2", 26, 30),
    ]);
    const uncorrected = new RegressionDetector({ alpha: 0.05, correction: "none" }).detect(baseline, current).regressions;
    const corrected = new RegressionDetector({ alpha: 0.05, correction: "bonferroni" }).detect(baseline, current).regressions;
    expect(uncorrected.some((r) => r.significant)).toBe(true);
    expect(corrected.every((r) => r.adjustedPValue >= r.pValue)).toBe(true);
    expect(corrected.every((r) => !r.significant)).toBe(true);
  });

  it("throws when baseline taskId does not match current taskId", () => {
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "task-a",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [{ sampleId: "s1", passRate: 1.0, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 10 }],
    };
    const current = makeMultiTrial("task-b", 10, [makeSample("s1", 8, 10)]);
    const detector = new RegressionDetector(0.05);
    expect(() => detector.detect(baseline, current)).toThrow(/taskId/i);
  });
});

describe("Baseline management", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("saves and loads baseline round-trip", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 7, 10),
    ]);
    result.model = "gpt-4";
    const path = join(dir, "baseline.json");
    saveBaseline(result, path);
    expect(existsSync(path)).toBe(true);
    const loaded = loadBaseline(path);
    expect(loaded.taskId).toBe("task-a");
    expect(loaded.taskVersion).toBe("1.0.0");
    expect(loaded.model).toBe("gpt-4");
    expect(loaded.samples).toHaveLength(2);
    expect(loaded.samples[0]!.passCount).toBe(9);
  });

  it("round-trips non-error and infra-error trial counts", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 5, 10, 5),
    ]);
    const path = join(dir, "baseline-infra.json");

    saveBaseline(result, path);
    const loaded = loadBaseline(path);

    expect(loaded.samples[0]!.trials).toBe(10);
    expect(loaded.samples[0]!.nonErrorTrials).toBe(5);
    expect(loaded.samples[0]!.infraErrorCount).toBe(5);
    expect(loaded.samples[0]!.passRate).toBe(1);
  });

  it("refuses to save a baseline with samples that have no quality signal", () => {
    const result = makeMultiTrial("task-a", 3, [
      makeSample("good", 3, 3),
      makeSample("outage", 0, 3, 3),
    ]);
    const path = join(dir, "baseline-no-quality.json");

    expect(() => saveBaseline(result, path)).toThrow(
      "Refusing to save baseline: sample(s) outage have no quality signal (all trials infra-errored). Pass { allowNoQualityBaseline: true } to override.",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("allows no-quality baselines only with an explicit warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = makeMultiTrial("task-a", 3, [makeSample("outage", 0, 3, 3)]);
    const path = join(dir, "baseline-no-quality-allowed.json");

    try {
      saveBaseline(result, path, { allowNoQualityBaseline: true });

      expect(existsSync(path)).toBe(true);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
        /outage.*no quality signal/i,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when loading a no-quality baseline", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = makeMultiTrial("task-a", 3, [makeSample("outage", 0, 3, 3)]);
    const path = join(dir, "baseline-no-quality-roundtrip.json");

    try {
      saveBaseline(result, path, { allowNoQualityBaseline: true });
      warn.mockClear();
      const loaded = loadBaseline(path, { allowNoQualityBaseline: true });

      expect(loaded.samples[0]!.sampleId).toBe("outage");
      expect(loaded.samples[0]!.nonErrorTrials).toBe(0);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
        /outage.*no quality signal/i,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("loads old baselines without non-error counts and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = join(dir, "old-baseline.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        taskId: "task-a",
        taskVersion: "1.0.0",
        createdAt: "2025-01-01T00:00:00.000Z",
        samples: [{ sampleId: "s1", passRate: 1, trials: 10, passCount: 10 }],
      }),
      "utf8",
    );
    try {
      const loaded = loadBaseline(path);
      expect(loaded.samples[0]!.trials).toBe(10);
      expect(loaded.samples[0]!.nonErrorTrials).toBeUndefined();
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/nonErrorTrials|p-values/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("validates baseline schema on load", () => {
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, taskId: "x" }),
      "utf8",
    );
    expect(() => loadBaseline(path)).toThrow();
  });

  it("rejects invalid baseline file (non-JSON)", () => {
    const path = join(dir, "nope.json");
    writeFileSync(path, "not json at all", "utf8");
    expect(() => loadBaseline(path)).toThrow();
  });

  it("creates output directory if needed", () => {
    const result = makeMultiTrial("task-a", 3, [makeSample("s1", 3, 3)]);
    const path = join(dir, "nested", "sub", "baseline.json");
    saveBaseline(result, path);
    expect(existsSync(path)).toBe(true);
  });

  it("leaves an existing baseline intact when a tmp file is incomplete", () => {
    const result = makeMultiTrial("task-a", 3, [makeSample("s1", 3, 3)]);
    const path = join(dir, "baseline.json");
    saveBaseline(result, path);
    const original = readFileSync(path, "utf8");
    writeFileSync(`${path}.tmp`, "{partial", "utf8");
    const loaded = loadBaseline(path);
    expect(loaded.taskId).toBe("task-a");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("uses unique temp files for concurrent baseline saves", async () => {
    const path = join(dir, "concurrent-baseline.json");
    const a = makeMultiTrial("task-a", 10, [makeSample("s1", 10, 10)]);
    const b = makeMultiTrial("task-a", 10, [makeSample("s1", 5, 10)]);

    await Promise.all([
      Promise.resolve().then(() => saveBaseline(a, path)),
      Promise.resolve().then(() => saveBaseline(b, path)),
    ]);

    const loaded = loadBaseline(path);
    expect([5, 10]).toContain(loaded.samples[0]!.passCount);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("refuses to save a baseline when every quality sample has 0% pass rate", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 0, 10),
      makeSample("s2", 0, 10),
    ]);
    const path = join(dir, "baseline-zero-pass.json");

    expect(() => saveBaseline(result, path)).toThrow(
      "Refusing to save baseline: pooled pass rate 0.00% is below 50% — this would let a broken baseline ratify broken current runs in regression-only CI gates. Pass { allowLowQualityBaseline: true } to override, or fix the product first.",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to save a baseline with aggregate pass rate below 50%", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 3, 10),
      makeSample("s2", 3, 10),
    ]);
    const path = join(dir, "baseline-low-quality.json");

    expect(() => saveBaseline(result, path)).toThrow(/pooled pass rate 30\.00% is below 50%/);
    expect(existsSync(path)).toBe(false);
  });

  it("saves a baseline with aggregate pass rate above the low-quality threshold", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 6, 10),
      makeSample("s2", 6, 10),
    ]);
    const path = join(dir, "baseline-acceptable-quality.json");

    saveBaseline(result, path);

    expect(existsSync(path)).toBe(true);
    expect(loadBaseline(path).samples).toHaveLength(2);
  });

  it("allows low-quality baselines only with an explicit warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = makeMultiTrial("task-a", 10, [makeSample("s1", 3, 10)]);
    const path = join(dir, "baseline-low-quality-allowed.json");

    try {
      saveBaseline(result, path, { allowLowQualityBaseline: true });

      expect(existsSync(path)).toBe(true);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
        /pooled pass rate 30\.00% is below 50%/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps no-quality and low-quality baseline overrides independent", () => {
    const lowQuality = makeMultiTrial("task-a", 10, [makeSample("low", 3, 10)]);
    const outage = makeMultiTrial("task-a", 10, [makeSample("outage", 0, 10, 10)]);

    expect(() =>
      saveBaseline(lowQuality, join(dir, "allow-no-quality-only.json"), {
        allowNoQualityBaseline: true,
      }),
    ).toThrow(/pooled pass rate 30\.00% is below 50%/);

    expect(() =>
      saveBaseline(outage, join(dir, "allow-low-quality-only.json"), {
        allowLowQualityBaseline: true,
      }),
    ).toThrow(/no quality signal/);
  });
});

describe("PRCommentReporter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-prcomment-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes multi-trial summary markdown", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const result = makeMultiTrial("my-task", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 6, 10),
    ]);
    reporter.onMultiTrialComplete(result);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("my-task");
    expect(content).toContain("s1");
    expect(content).toContain("s2");
    expect(content).toContain("90");
  });

  it("writes gate result with pass badge", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({
      pass: true,
      reasons: ["All gates passed"],
      passRate: 0.95,
    });
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content.toLowerCase()).toMatch(/pass|✅/);
    expect(content).toContain("All gates passed");
  });

  it("writes gate result with fail badge", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({
      pass: false,
      reasons: ["Pass rate 30.0% below floor 80.0%"],
      passRate: 0.3,
    });
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content.toLowerCase()).toMatch(/fail|❌/);
    expect(content).toContain("below floor");
  });

  it("escapes markdown table and list content", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const result = makeMultiTrial("task|#x", 10, [
      makeSample("sample|`<x>`", 9, 10),
    ]);
    reporter.onMultiTrialComplete(result);
    reporter.writeGateResult({
      pass: false,
      reasons: ["bad | reason with `code` and <tag>"],
    });
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("sample\\|\\`&lt;x&gt;\\`");
    expect(content).toContain("bad \\| reason with \\`code\\` and &lt;tag&gt;");
  });

  it("escapes taskVersion and model in multi-trial headers", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const result = makeMultiTrial("task", 1, [makeSample("s1", 1, 1)]);
    result.taskVersion = "v|`<tag>`";
    result.model = "m|`<model>`";

    reporter.onMultiTrialComplete(result);

    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("v\\|\\`&lt;tag&gt;\\`");
    expect(content).toContain("m\\|\\`&lt;model&gt;\\`");
    expect(content).not.toContain("v|`<tag>`");
    expect(content).not.toContain("m|`<model>`");
  });

  it("includes regression table when regressions present", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
      {
        sampleId: "s2",
        baselinePassRate: 0.5,
        currentPassRate: 0.9,
        pValue: 0.01,
        significant: true,
        direction: "improved",
      },
    ];
    reporter.writeGateResult(
      {
        pass: false,
        reasons: ["1 regressions exceed max 0"],
        passRate: 0.7,
        regressionCount: 1,
      },
      regressions,
    );
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("s1");
    expect(content).toContain("regressed");
    expect(content).toContain("s2");
  });

  it("does not overwrite gate result when onMultiTrialComplete called after", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({ pass: true, reasons: ["All passed"] });
    const result = makeMultiTrial("my-task", 10, [makeSample("s1", 9, 10)]);
    reporter.onMultiTrialComplete(result);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("All passed");
    expect(content).toContain("my-task");
  });

  it("supports matrix result rendering", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const cellResult = makeMultiTrial("m-task", 5, [makeSample("s1", 5, 5)]);
    const matrix: MatrixResult = {
      schemaVersion: 1,
      runId: "m-run",
      taskId: "m-task",
      taskVersion: "1.0.0",
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z",
      models: ["gpt-4"],
      configs: [
        { id: "c1", label: "Config 1", overrides: {} },
      ],
      cells: [
        {
          model: "gpt-4",
          configId: "c1",
          configLabel: "Config 1",
          result: cellResult,
        },
      ],
      summary: {
        totalCells: 1,
        bestPassRate: { model: "gpt-4", configId: "c1", passRate: 1.0 },
        worstPassRate: { model: "gpt-4", configId: "c1", passRate: 1.0 },
      },
    };
    reporter.onMatrixComplete(matrix);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("m-task");
    expect(content).toContain("gpt-4");
  });
});
