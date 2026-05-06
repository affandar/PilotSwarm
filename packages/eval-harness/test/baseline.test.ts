import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveBaseline, loadBaseline } from "../src/baseline.js";
import type { Baseline, MultiTrialResult } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws3-baseline-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBaselineFile(filePath: string, baseline: Baseline): void {
  writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf8");
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    schemaVersion: 1,
    taskId: "task-a",
    taskVersion: "1.0.0",
    createdAt: "2025-01-01T00:00:00.000Z",
    samples: [
      { sampleId: "s1", passRate: 0, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 0 },
      { sampleId: "s2", passRate: 0, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 0 },
    ],
    ...overrides,
  };
}

describe("loadBaseline — quality gates", () => {
  it("refuses to load a low-quality (sub-50%) baseline by default", () => {
    const path = join(dir, "low.json");
    writeBaselineFile(path, makeBaseline());
    expect(() => loadBaseline(path)).toThrow(/pooled pass rate 0\.00% is below 50%/);
  });

  it("loads a low-quality baseline with allowLowQualityBaseline: true and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = join(dir, "low-allowed.json");
    writeBaselineFile(path, makeBaseline());
    try {
      const loaded = loadBaseline(path, { allowLowQualityBaseline: true });
      expect(loaded.samples).toHaveLength(2);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/pooled pass rate 0\.00% is below 50%/);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to load a no-quality baseline by default; loads with allowNoQualityBaseline: true and warns", () => {
    const path = join(dir, "no-quality.json");
    writeBaselineFile(
      path,
      makeBaseline({
        samples: [{ sampleId: "outage", passRate: 0, trials: 10, nonErrorTrials: 0, infraErrorCount: 10, passCount: 0 }],
      }),
    );
    expect(() => loadBaseline(path)).toThrow(/no quality signal/i);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = loadBaseline(path, { allowNoQualityBaseline: true });
      expect(loaded.samples[0]!.sampleId).toBe("outage");
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/outage.*no quality signal/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("loads a healthy baseline without options", () => {
    const path = join(dir, "healthy.json");
    writeBaselineFile(
      path,
      makeBaseline({
        samples: [
          { sampleId: "s1", passRate: 0.9, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 9 },
        ],
      }),
    );
    expect(loadBaseline(path).samples[0]!.passRate).toBe(0.9);
  });

  it("keeps no-quality and low-quality load overrides independent", () => {
    const lowPath = join(dir, "low-only.json");
    writeBaselineFile(lowPath, makeBaseline());
    const outagePath = join(dir, "outage-only.json");
    writeBaselineFile(
      outagePath,
      makeBaseline({
        samples: [{ sampleId: "outage", passRate: 0, trials: 10, nonErrorTrials: 0, infraErrorCount: 10, passCount: 0 }],
      }),
    );
    expect(() => loadBaseline(lowPath, { allowNoQualityBaseline: true })).toThrow(/pooled pass rate 0\.00% is below 50%/);
    expect(() => loadBaseline(outagePath, { allowLowQualityBaseline: true })).toThrow(/no quality signal/i);
  });
});

function makeMultiTrialResultFromSamples(
  samples: Array<{ sampleId: string; trials: number; passCount: number; failCount: number; errorCount: number }>,
): MultiTrialResult {
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-a",
    taskVersion: "1.0.0",
    trials: 0,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: { total: samples.length, trials: 0, infraErrorRate: 0, stddevPassRate: 0, passRateCI: { point: 0, lower: 0, upper: 0 } },
    samples: samples.map((s) => {
      const denom = s.trials - s.errorCount;
      return {
        sampleId: s.sampleId,
        trials: s.trials,
        passCount: s.passCount,
        failCount: s.failCount,
        errorCount: s.errorCount,
        ...(denom > 0 ? { passRate: s.passCount / denom } : { noQualitySignal: true }),
        passAtK: {},
        scores: {},
        wilsonCI: { point: 0, lower: 0, upper: 0 },
      };
    }),
    rawRuns: [],
  } as unknown as MultiTrialResult;
}

describe("F2 — pooled (denominator-weighted) pass rate, not unweighted mean", () => {
  it("refuses to save when pooled rate < 50% even though unweighted mean = 50% (Simpson's paradox)", () => {
    const path = join(dir, "simpson-save.json");
    const result = makeMultiTrialResultFromSamples([
      { sampleId: "tiny", trials: 1, passCount: 1, failCount: 0, errorCount: 0 },
      { sampleId: "huge", trials: 100, passCount: 0, failCount: 100, errorCount: 0 },
    ]);
    expect(() => saveBaseline(result, path)).toThrow(/pooled pass rate 0\.99% is below 50%/);
  });

  it("refuses to load when pooled rate < 50% even though unweighted mean = 50%", () => {
    const path = join(dir, "simpson-load.json");
    writeBaselineFile(
      path,
      makeBaseline({
        samples: [
          { sampleId: "tiny", passRate: 1, trials: 1, nonErrorTrials: 1, infraErrorCount: 0, passCount: 1 },
          { sampleId: "huge", passRate: 0, trials: 100, nonErrorTrials: 100, infraErrorCount: 0, passCount: 0 },
        ],
      }),
    );
    expect(() => loadBaseline(path)).toThrow(/pooled pass rate 0\.99% is below 50%/);
  });

  it("accepts when pooled rate >= 50% even if a single small sample drags unweighted mean down", () => {
    const path = join(dir, "simpson-accept.json");
    writeBaselineFile(
      path,
      makeBaseline({
        samples: [
          { sampleId: "tiny-fail", passRate: 0, trials: 1, nonErrorTrials: 1, infraErrorCount: 0, passCount: 0 },
          { sampleId: "huge-pass", passRate: 1, trials: 100, nonErrorTrials: 100, infraErrorCount: 0, passCount: 100 },
        ],
      }),
    );
    expect(loadBaseline(path).samples).toHaveLength(2);
  });

  it("ignores no-quality (denom=0) samples when computing pooled rate", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = join(dir, "mixed-outage.json");
    writeBaselineFile(
      path,
      makeBaseline({
        samples: [
          { sampleId: "healthy", passRate: 0.9, trials: 10, nonErrorTrials: 10, infraErrorCount: 0, passCount: 9 },
          { sampleId: "outage", passRate: 0, trials: 10, nonErrorTrials: 0, infraErrorCount: 10, passCount: 0 },
        ],
      }),
    );
    try {
      expect(loadBaseline(path, { allowNoQualityBaseline: true }).samples).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});
