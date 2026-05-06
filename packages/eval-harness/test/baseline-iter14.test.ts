import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveBaseline, loadBaseline } from "../src/baseline.js";
import type { Baseline, MultiTrialResult } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws6-baseline-iter14-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBaselineFile(filePath: string, baseline: Baseline): void {
  writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf8");
}

function makeEmptyMultiTrialResult(): MultiTrialResult {
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-empty",
    taskVersion: "1.0.0",
    trials: 0,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: {
      total: 0,
      trials: 0,
      infraErrorRate: 0,
      stddevPassRate: 0,
      passRateCI: { point: 0, lower: 0, upper: 0 },
    },
    samples: [],
    rawRuns: [],
  } as unknown as MultiTrialResult;
}

function makeEmptyBaselineFile(): Baseline {
  return {
    schemaVersion: 1,
    taskId: "task-empty",
    taskVersion: "1.0.0",
    createdAt: "2025-01-01T00:00:00.000Z",
    samples: [],
  };
}

describe("F2 + F29 — refuse empty baseline save/load", () => {
  it("saveBaseline throws when samples is empty (default)", () => {
    const path = join(dir, "empty-save.json");
    expect(() => saveBaseline(makeEmptyMultiTrialResult(), path)).toThrow(
      /baseline has zero samples; pass allowEmptyBaseline:true to opt in/,
    );
  });

  it("saveBaseline succeeds when samples is empty and allowEmptyBaseline:true", () => {
    const path = join(dir, "empty-save-allowed.json");
    expect(() =>
      saveBaseline(makeEmptyMultiTrialResult(), path, {
        allowEmptyBaseline: true,
      }),
    ).not.toThrow();
    const written = JSON.parse(readFileSync(path, "utf8")) as Baseline;
    expect(written.samples).toHaveLength(0);
    expect(written.taskId).toBe("task-empty");
  });

  it("loadBaseline throws when stored baseline has zero samples (default)", () => {
    const path = join(dir, "empty-load.json");
    writeBaselineFile(path, makeEmptyBaselineFile());

    expect(() => loadBaseline(path)).toThrow(
      /baseline has zero samples; pass allowEmptyBaseline:true to opt in/,
    );
  });

  it("loadBaseline succeeds when stored baseline has zero samples and allowEmptyBaseline:true", () => {
    const path = join(dir, "empty-load-allowed.json");
    writeBaselineFile(path, makeEmptyBaselineFile());

    const loaded = loadBaseline(path, { allowEmptyBaseline: true });
    expect(loaded.samples).toHaveLength(0);
    expect(loaded.taskId).toBe("task-empty");
  });

  it("empty-baseline check fires before no-quality / low-quality checks", () => {
    // If empty check is correctly first, we should hit the empty-message,
    // not no-quality or low-quality refusals.
    const path = join(dir, "empty-precedence.json");
    writeBaselineFile(path, makeEmptyBaselineFile());

    expect(() => loadBaseline(path)).toThrow(/zero samples/);
    expect(() => loadBaseline(path)).not.toThrow(/no quality signal/);
    expect(() => loadBaseline(path)).not.toThrow(/pooled pass rate/);
  });
});

describe("F3 — warnOrRefuseNoQualityBaseline uses (nonErrorTrials ?? trials) for denom", () => {
  it("refuses load when an old-format sample has trials=0 and no nonErrorTrials field", () => {
    // Old-format sample: no nonErrorTrials, no infraErrorCount, trials=0 — denom must
    // fall back to trials=0 and be detected as no-quality.
    const path = join(dir, "old-format-zero.json");
    writeBaselineFile(path, {
      schemaVersion: 1,
      taskId: "task-old",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [
        {
          sampleId: "old-zero",
          passRate: 0,
          trials: 0,
          passCount: 0,
        },
      ],
    } as Baseline);

    expect(() => loadBaseline(path)).toThrow(/no quality signal/i);
  });

  it("refuses load when nonErrorTrials=0 (current-format sample)", () => {
    const path = join(dir, "current-format-zero.json");
    writeBaselineFile(path, {
      schemaVersion: 1,
      taskId: "task-current",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [
        {
          sampleId: "outage",
          passRate: 0,
          trials: 5,
          nonErrorTrials: 0,
          infraErrorCount: 5,
          passCount: 0,
        },
      ],
    } as Baseline);

    expect(() => loadBaseline(path)).toThrow(/no quality signal/i);
  });

  it("allows old-format trials=0 sample when allowNoQualityBaseline:true and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = join(dir, "old-format-zero-allowed.json");
    writeBaselineFile(path, {
      schemaVersion: 1,
      taskId: "task-old",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: [
        {
          sampleId: "old-zero",
          passRate: 0,
          trials: 0,
          passCount: 0,
        },
      ],
    } as Baseline);

    try {
      const loaded = loadBaseline(path, { allowNoQualityBaseline: true });
      expect(loaded.samples).toHaveLength(1);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(
        /old-zero.*no quality signal/i,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
