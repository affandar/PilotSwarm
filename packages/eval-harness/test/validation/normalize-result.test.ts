import { describe, it, expect } from "vitest";
import {
  normalizeObservedResult,
  normalizeRunResult,
  normalizeMultiTrialResult,
  normalizeMatrixConfig,
  normalizeMatrixResult,
  normalizeBaseline,
} from "../../src/validation/normalize-result.js";

const validObserved = {
  toolCalls: [],
  finalResponse: "",
  sessionId: "s",
  latencyMs: 0,
};

const validRun = {
  schemaVersion: 1,
  runId: "r",
  taskId: "t",
  taskVersion: "1",
  startedAt: "a",
  finishedAt: "b",
  summary: { total: 0, passed: 0, failed: 0, errored: 0, noQualitySignal: true },
  cases: [],
};

const validMultiTrial = {
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
};

const validMatrixCfg = { id: "c", label: "l", overrides: {} };

const validMatrixResult = {
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
};

const validBaseline = {
  schemaVersion: 1,
  taskId: "t",
  taskVersion: "1",
  createdAt: "2025-01-01T00:00:00.000Z",
  samples: [{ sampleId: "s", passRate: 0, trials: 0, passCount: 0 }],
};

describe("validation/normalize-result", () => {
  describe("normalizeObservedResult", () => {
    it("returns ok+data on valid", () => {
      const r = normalizeObservedResult(validObserved);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Object.isFrozen(r.data)).toBe(true);
      }
    });
    it("returns infraScore on invalid (does NOT throw)", () => {
      const r = normalizeObservedResult({ toolCalls: "not-an-array" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.infraScore.infraError).toBe(true);
        expect(r.infraScore.name).toBe("driver-output-shape");
      }
    });
    it("returns infraScore on Symbol payload", () => {
      const r = normalizeObservedResult({ ...validObserved, evil: Symbol("x") });
      expect(r.ok).toBe(false);
    });
  });

  describe("normalizeRunResult", () => {
    it("returns frozen data on valid", () => {
      const r = normalizeRunResult(validRun);
      expect(Object.isFrozen(r)).toBe(true);
    });
    it("throws on invalid", () => {
      expect(() => normalizeRunResult({ bad: true })).toThrow(
        /normalizeRunResult/,
      );
    });
    it("throws on Function inside z.unknown slot (delegates to trust-boundary)", () => {
      // Build a CaseResult whose observed.toolCalls[i].args (z.unknown()) holds
      // a Function — Zod accepts inside z.unknown(), trust-boundary walker rejects.
      const evilRun = {
        ...validRun,
        cases: [
          {
            caseId: "c1",
            pass: true,
            scores: [],
            observed: {
              toolCalls: [{ name: "x", args: { evil: () => 1 }, order: 0 }],
              finalResponse: "",
              sessionId: "s",
              latencyMs: 0,
            },
            durationMs: 0,
          },
        ],
        summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1, infraErrorRate: 0 },
      };
      expect(() => normalizeRunResult(evilRun)).toThrow(/forbidden function/);
    });
  });

  describe("normalizeMultiTrialResult", () => {
    it("returns frozen data on valid", () => {
      const r = normalizeMultiTrialResult(validMultiTrial);
      expect(Object.isFrozen(r)).toBe(true);
    });
    it("throws on invalid", () => {
      expect(() => normalizeMultiTrialResult({ bad: true })).toThrow(
        /normalizeMultiTrialResult/,
      );
    });
  });

  describe("normalizeMatrixConfig", () => {
    it("returns frozen data on valid", () => {
      const r = normalizeMatrixConfig(validMatrixCfg);
      expect(Object.isFrozen(r)).toBe(true);
    });
    it("throws on invalid (missing id)", () => {
      expect(() => normalizeMatrixConfig({ label: "x" })).toThrow();
    });
  });

  describe("normalizeMatrixResult", () => {
    it("returns frozen data on valid", () => {
      const r = normalizeMatrixResult(validMatrixResult);
      expect(Object.isFrozen(r)).toBe(true);
    });
    it("throws on invalid", () => {
      expect(() => normalizeMatrixResult({ bad: true })).toThrow();
    });
  });

  describe("normalizeBaseline", () => {
    it("strict mode rejects empty samples by default", () => {
      expect(() =>
        normalizeBaseline({ ...validBaseline, samples: [] }),
      ).toThrow();
    });
    it("allowEmpty:true accepts empty samples", () => {
      expect(() =>
        normalizeBaseline({ ...validBaseline, samples: [] }, { allowEmpty: true }),
      ).not.toThrow();
    });
    it("returns frozen data on valid", () => {
      const r = normalizeBaseline(validBaseline);
      expect(Object.isFrozen(r)).toBe(true);
    });
    // Note: BaselineSchema is fully strict (no z.unknown() slots), so BigInt
    // deep-walk path is exercised through trust-boundary.test.ts directly.
  });
});

describe("normalizeObservedResult: cmsEvents projection (G9)", () => {
  it("preserves cmsEvents through projection when present", () => {
    const raw = {
      toolCalls: [],
      finalResponse: "ok",
      sessionId: "sid",
      latencyMs: 10,
      cmsEvents: [
        {
          seq: 1,
          eventType: "user.message",
          data: { content: "hi" },
          createdAt: "2026-01-01T00:00:00.000Z",
          workerNodeId: "worker-a",
        },
        {
          seq: 2,
          eventType: "session.turn_completed",
          createdAt: "2026-01-01T00:00:01.000Z",
          workerNodeId: "worker-b",
        },
      ],
    };
    const r = normalizeObservedResult(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.data.cmsEvents)).toBe(true);
    expect(r.data.cmsEvents).toHaveLength(2);
    expect(r.data.cmsEvents![0]!.workerNodeId).toBe("worker-a");
    expect(r.data.cmsEvents![1]!.workerNodeId).toBe("worker-b");
    // Worker handoff verification: distinct workerNodeId across consecutive
    // events is the canonical signal the durability suite uses.
    const ids = r.data.cmsEvents!.map((e) => e.workerNodeId);
    expect(new Set(ids).size).toBeGreaterThan(1);
  });

  it("leaves cmsEvents undefined when absent from input (back-compat)", () => {
    const raw = {
      toolCalls: [],
      finalResponse: "ok",
      sessionId: "sid",
      latencyMs: 10,
    };
    const r = normalizeObservedResult(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cmsEvents).toBeUndefined();
  });

  it("rejects malformed cmsEvents entries (strict per-event schema)", () => {
    const raw = {
      toolCalls: [],
      finalResponse: "",
      sessionId: "sid",
      latencyMs: 0,
      cmsEvents: [
        {
          seq: -1, // invalid: must be non-negative
          eventType: "x",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const r = normalizeObservedResult(raw);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown extra keys on cmsEvents entries (strict)", () => {
    const raw = {
      toolCalls: [],
      finalResponse: "",
      sessionId: "sid",
      latencyMs: 0,
      cmsEvents: [
        {
          seq: 0,
          eventType: "x",
          createdAt: "2026-01-01T00:00:00.000Z",
          // strict — unknown key must be rejected.
          surprise: "no-passthrough",
        },
      ],
    };
    const r = normalizeObservedResult(raw);
    expect(r.ok).toBe(false);
  });
});
