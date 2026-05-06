import { describe, it, expect } from "vitest";
import { BudgetChecker, BaselineComparator } from "../../src/perf/perf-budget.js";
import type {
  PerfBudget,
  PerfReport,
  PerfBaseline,
} from "../../src/perf/perf-budget.js";

const availP = (overrides: Partial<{ count: number; p50: number; p95: number; p99: number; min: number; max: number; meanMs: number }> = {}) => ({
  count: 1,
  p50: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  meanMs: 0,
  available: true as const,
  source: "explicit" as const,
  ...overrides,
});

const unavailP = (reason: string) => ({
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  meanMs: 0,
  available: false as const,
  source: "none" as const,
  unavailableReason: reason,
});

describe("BudgetChecker", () => {
  it("passes empty budget and empty report", () => {
    const r = BudgetChecker.check({}, {});
    expect(r.passed).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("checks latency p50/p95/p99 against budget", () => {
    const budget: PerfBudget = { latency: { p50Ms: 100, p95Ms: 200, p99Ms: 300 } };
    const ok: PerfReport = {
      latency: { count: 5, p50: 50, p95: 150, p99: 250, min: 10, max: 250, meanMs: 100 },
    };
    expect(BudgetChecker.check(budget, ok).passed).toBe(true);
    const bad: PerfReport = {
      latency: { count: 5, p50: 250, p95: 400, p99: 500, min: 100, max: 500, meanMs: 300 },
    };
    const r = BudgetChecker.check(budget, bad);
    expect(r.passed).toBe(false);
    expect(r.violations).toHaveLength(3);
  });

  it("checks cost per-trial and per-run", () => {
    const budget: PerfBudget = { cost: { perTrialUsd: 0.1, perRunUsd: 0.5 } };
    const okReport: PerfReport = { cost: { totalUsd: 0.3, perTrialUsd: 0.1, trials: 3 } };
    expect(BudgetChecker.check(budget, okReport).passed).toBe(true);
    const fail: PerfReport = { cost: { totalUsd: 0.6, perTrialUsd: 0.2, trials: 3 } };
    const r = BudgetChecker.check(budget, fail);
    expect(r.passed).toBe(false);
    expect(r.violations).toHaveLength(2);
  });

  it("checks DB perTurn / perSpawn / perSweep / total", () => {
    const budget: PerfBudget = {
      dbQueries: { perTurn: 50, perSpawn: 100, perSweep: 20, totalQueries: 500 },
    };
    const ok: PerfReport = {
      dbPerTurn: 45,
      dbPerSpawn: 80,
      dbPerSweep: 15,
      dbDelta: {
        available: true,
        queries: 400,
        execTimeMs: 100,
        topSlowDelta: [],
        byCategory: {
          orchestration: 0,
          cms: 0,
          facts: 0,
          "session-store": 0,
          "blob-store": 0,
          other: 0,
        },
      },
    };
    expect(BudgetChecker.check(budget, ok).passed).toBe(true);
    const bad: PerfReport = {
      ...ok,
      dbPerTurn: 60,
      dbPerSpawn: 200,
      dbPerSweep: 30,
      dbDelta: { ...ok.dbDelta!, queries: 600 },
    };
    const r = BudgetChecker.check(budget, bad);
    expect(r.passed).toBe(false);
    expect(r.violations.length).toBe(4);
  });

  // ── B2: fail-closed semantics ──

  it("FAILS CLOSED when latency is configured but report.latency missing", () => {
    const r = BudgetChecker.check({ latency: { p50Ms: 1, p95Ms: 1, p99Ms: 1 } }, {});
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/latency.*missing/);
  });

  it("FAILS CLOSED when cost is configured but report.cost missing", () => {
    const r = BudgetChecker.check({ cost: { perTrialUsd: 1, perRunUsd: 1 } }, {});
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/cost.*missing/);
  });

  it("FAILS CLOSED when dbQueries.perTurn configured but dbPerTurn missing", () => {
    const r = BudgetChecker.check({ dbQueries: { perTurn: 50 } }, {});
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("dbPerTurn"))).toBe(true);
  });

  it("FAILS CLOSED when dbQueries configured but pg_stat_statements unavailable", () => {
    const budget: PerfBudget = { dbQueries: { perTurn: 50, totalQueries: 500 } };
    const report: PerfReport = {
      dbDelta: {
        available: false,
        unavailableReason: "missing extension",
        queries: 0,
        execTimeMs: 0,
        topSlowDelta: [],
        byCategory: {
          orchestration: 0,
          cms: 0,
          facts: 0,
          "session-store": 0,
          "blob-store": 0,
          other: 0,
        },
      },
    };
    const r = BudgetChecker.check(budget, report);
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/pg_stat_statements unavailable/);
  });

  it("OPTIONAL flag restores legacy skip-if-missing behavior", () => {
    const r = BudgetChecker.check(
      { latency: { p50Ms: 1, p95Ms: 1, p99Ms: 1, optional: true } },
      {},
    );
    expect(r.passed).toBe(true);
  });

  it("OPTIONAL flag still fails on threshold violation when data present", () => {
    const r = BudgetChecker.check(
      { latency: { p50Ms: 1, p95Ms: 1, p99Ms: 1, optional: true } },
      {
        latency: { count: 1, p50: 100, p95: 100, p99: 100, min: 100, max: 100, meanMs: 100 },
      },
    );
    expect(r.passed).toBe(false);
  });

  it("FAILS CLOSED when durability configured but report.durability missing", () => {
    const r = BudgetChecker.check(
      { durability: { rehydrateP95Ms: 100 } },
      {},
    );
    expect(r.passed).toBe(false);
  });

  it("FAILS CLOSED when durability sub-op marked unavailable", () => {
    const r = BudgetChecker.check(
      { durability: { rehydrateP95Ms: 100 } },
      {
        durability: {
          rehydrate: unavailP("no source"),
          replay: unavailP("deferred"),
          checkpoint: unavailP("deferred"),
          dehydrate: unavailP("no source"),
        },
      },
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("rehydrate"))).toBe(true);
  });

  it("FAILS CLOSED when durability sub-op has zero samples", () => {
    const r = BudgetChecker.check(
      { durability: { rehydrateP95Ms: 100 } },
      {
        durability: {
          rehydrate: availP({ count: 0 }),
          replay: unavailP("deferred"),
          checkpoint: availP({ count: 0 }),
          dehydrate: availP({ count: 0 }),
        },
      },
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("zero samples"))).toBe(true);
  });

  it("checks durability p95s when measurements are real", () => {
    const budget: PerfBudget = {
      durability: {
        rehydrateP95Ms: 100,
        replayP95Ms: 200,
        checkpointP95Ms: 50,
        dehydrateP95Ms: 80,
      },
    };
    const ok: PerfReport = {
      durability: {
        rehydrate: availP({ count: 1, p50: 10, p95: 50, p99: 50, min: 10, max: 50, meanMs: 30 }),
        replay: availP({ count: 1, p50: 10, p95: 100, p99: 100, min: 10, max: 100, meanMs: 50 }),
        checkpoint: availP({ count: 1, p50: 10, p95: 30, p99: 30, min: 10, max: 30, meanMs: 20 }),
        dehydrate: availP({ count: 1, p50: 10, p95: 70, p99: 70, min: 10, max: 70, meanMs: 30 }),
      },
    };
    expect(BudgetChecker.check(budget, ok).passed).toBe(true);
    const bad: PerfReport = {
      durability: {
        ...ok.durability!,
        rehydrate: availP({ count: 1, p50: 10, p95: 200, p99: 200, min: 10, max: 200, meanMs: 100 }),
      },
    };
    const r = BudgetChecker.check(budget, bad);
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("rehydrate"))).toBe(true);
  });

  it("FAILS CLOSED when resource configured but memory missing", () => {
    const r = BudgetChecker.check(
      { resource: { peakRssMB: 100 } },
      { resource: {} },
    );
    expect(r.passed).toBe(false);
  });

  it("checks resource peakRssMB and peakConnections", () => {
    const budget: PerfBudget = { resource: { peakRssMB: 200, peakConnections: 10 } };
    const ok: PerfReport = {
      resource: {
        memory: { samples: [100], peakRssMB: 150, meanRssMB: 100, durationMs: 100 },
        activity: { samples: [], peak: 5, meanByDatabase: {}, peakByDatabase: {}, durationMs: 100 },
      },
    };
    expect(BudgetChecker.check(budget, ok).passed).toBe(true);
    const bad: PerfReport = {
      resource: {
        memory: { samples: [], peakRssMB: 300, meanRssMB: 250, durationMs: 100 },
        activity: { samples: [], peak: 20, meanByDatabase: {}, peakByDatabase: {}, durationMs: 100 },
      },
    };
    const r = BudgetChecker.check(budget, bad);
    expect(r.passed).toBe(false);
    expect(r.violations).toHaveLength(2);
  });

  it("FAILS CLOSED when concurrency configured but report missing", () => {
    const r = BudgetChecker.check(
      { concurrency: { scalingFactorMax: 2 } },
      {},
    );
    expect(r.passed).toBe(false);
  });

  it("FAILS CLOSED when concurrency profile aborted by capacity guard", () => {
    const r = BudgetChecker.check(
      { concurrency: { scalingFactorMax: 2 } },
      {
        concurrency: {
          byN: {},
          scalingFactor: 1,
          levels: [1, 8],
          abortedReason: "capacity guard exceeded",
        },
      },
    );
    expect(r.passed).toBe(false);
    expect(r.violations[0]).toMatch(/aborted.*capacity/);
  });

  it("checks concurrency scalingFactor, failures, and failureRateMax", () => {
    const budget: PerfBudget = {
      concurrency: { scalingFactorMax: 2, failuresMax: 0, failureRateMax: 0.1 },
    };
    const ok: PerfReport = {
      concurrency: {
        scalingFactor: 1.5,
        levels: [1, 4],
        byN: {
          1: {
            count: 1,
            meanLatency: 100,
            p50Latency: 100,
            p95Latency: 100,
            failures: 0,
            failureRate: 0,
            effectiveMeanLatency: 100,
            percentiles: availP({ count: 1, p50: 100, p95: 100, p99: 100, min: 100, max: 100, meanMs: 100 }),
          },
          4: {
            count: 4,
            meanLatency: 150,
            p50Latency: 150,
            p95Latency: 150,
            failures: 0,
            failureRate: 0,
            effectiveMeanLatency: 150,
            percentiles: availP({ count: 4, p50: 150, p95: 150, p99: 150, min: 150, max: 150, meanMs: 150 }),
          },
        },
      },
    };
    expect(BudgetChecker.check(budget, ok).passed).toBe(true);

    const bad: PerfReport = {
      concurrency: {
        ...ok.concurrency!,
        scalingFactor: 3,
        byN: {
          ...ok.concurrency!.byN,
          4: {
            ...ok.concurrency!.byN[4]!,
            failures: 2,
            failureRate: 0.5,
          },
        },
      },
    };
    const r = BudgetChecker.check(budget, bad);
    expect(r.passed).toBe(false);
    // scalingFactor + failuresMax + failureRateMax all violated
    expect(r.violations.length).toBe(3);
  });
});

describe("BaselineComparator", () => {
  const baseline: PerfBaseline = {
    version: "v1",
    capturedAt: "2025-01-01T00:00:00Z",
    metrics: {
      latencyP95Ms: 1000,
      dbPerTurn: 100,
    },
  };

  it("passes when observed within tolerance × baseline", () => {
    const r = BaselineComparator.compare(
      baseline,
      {
        latency: availP({ count: 1, p95: 1200, p50: 100, p99: 100, min: 100, max: 100, meanMs: 100 }),
        dbPerTurn: 110,
      },
      { tolerance: 1.5 },
    );
    expect(r.passed).toBe(true);
  });

  it("fails when observed exceeds tolerance × baseline (catches doublings)", () => {
    const r = BaselineComparator.compare(
      baseline,
      {
        latency: availP({ count: 1, p95: 2000, p50: 100, p99: 100, min: 100, max: 100, meanMs: 100 }),
        dbPerTurn: 200,
      },
      { tolerance: 1.5 },
    );
    expect(r.passed).toBe(false);
    expect(r.violations.length).toBe(2);
  });

  it("fails when baseline metric exists but observation missing", () => {
    const r = BaselineComparator.compare(baseline, {});
    expect(r.passed).toBe(false);
    // Both latencyP95 and dbPerTurn baselines lack observations.
    expect(r.violations.length).toBe(2);
  });

  it("respects absoluteFloor for noisy small numbers", () => {
    const r = BaselineComparator.compare(
      { version: "v1", capturedAt: "x", metrics: { dbPerTurn: 5 } },
      { dbPerTurn: 7 },
      { tolerance: 1.5, absoluteFloor: { dbPerTurn: 10 } },
    );
    // 7 > 5 × 1.5 = 7.5? No, 7 ≤ 7.5 so this would pass without floor.
    // But both base(5) and observed(7) below floor(10), so floor short-circuits.
    expect(r.passed).toBe(true);
    expect(r.details[0]?.dim).toMatch(/below floor/);
  });
});
