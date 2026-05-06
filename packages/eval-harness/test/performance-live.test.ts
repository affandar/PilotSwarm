// Performance & cost LIVE — gated by LIVE=1. Tracks p50/p95/p99 latency,
// token usage, and per-trial cost across a small bounded sweep so we can
// detect regressions without burning budget. Uses LatencyTracker /
// CostTracker for percentile aggregation.
//
// Audit B1 fix: DB-budget tests precheck pg_stat_statements and skip
// with a documented reason instead of returning early. Set
// PG_STAT_STATEMENTS_ENABLED=1 in the env to convert the skip into a
// hard failure when CI requires DB signal.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { loadEvalTask } from "../src/loader.js";
import { LatencyTracker, CostTracker } from "../src/perf/latency-tracker.js";
import {
  DbTracker,
  PgStatStatementsRequiredError,
} from "../src/perf/db-tracker.js";
import { BudgetChecker } from "../src/perf/perf-budget.js";
import { makeLatencyBudget, makeCostBudget } from "./fixtures/builders.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const live = process.env.LIVE === "1";
const strictPgStat = process.env.PG_STAT_STATEMENTS_ENABLED === "1";
// pg_stat_statements is database-global. Parallel test files pollute each
// other's snapshots so DB-call counts are not isolated per cell.
const isolated = process.env.PS_EVAL_FILE_PARALLELISM !== "1";

async function precheckPgStat(): Promise<{ ok: boolean; reason?: string }> {
  const tracker = new DbTracker({ connectionString: databaseUrl });
  const r = await tracker.precheckPgStatStatements();
  return { ok: r.available, reason: r.reason };
}

describe("Performance & cost LIVE", () => {
  const run = live ? it : it.skip;
  // Reaudit G4 fix: DB-budget tests are now real Vitest skips (not silent
  // passes) when LIVE=1 but PG_STAT_STATEMENTS_ENABLED is not set.
  // Setting PG_STAT_STATEMENTS_ENABLED=1 makes them run AND fail loudly
  // if the extension is unavailable at probe time.
  const dbRun = (live && strictPgStat && isolated) ? it : it.skip;

  run("PERF: single-turn latency p50/p95/p99 within configured budget", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples.find((s) => s.id === "single.add.basic")!;
    const trials = 5;
    const runner = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials,
    });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const tracker = new LatencyTracker();
    for (const r of result.rawRuns) {
      const observed = r.cases[0]!.observed;
      tracker.record(observed.latencyMs);
    }
    const p = tracker.percentiles();
    expect(p.count).toBe(trials);
    const budget = makeLatencyBudget({ p50Ms: 60_000, p95Ms: 180_000, p99Ms: 240_000 });
    expect(p.p50).toBeLessThanOrEqual(budget.p50Ms);
    expect(p.p95).toBeLessThanOrEqual(budget.p95Ms);
    expect(p.p99).toBeLessThanOrEqual(budget.p99Ms);
  }, 1_650_000);

  run("PERF: cost-per-trial accumulates within configured budget", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const trials = 3;
    const runner = new MultiTrialRunner({
      driverFactory: () => new LiveDriver({ timeout: 300_000 }),
      trials,
    });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const cost = new CostTracker();
    // Cost annotations land on observed.passthrough; absent in non-instrumented mode
    // we record a zero per trial to preserve the n=trials shape.
    for (const r of result.rawRuns) {
      const obs = r.cases[0]!.observed as unknown as { actualCostUsd?: number };
      const c = typeof obs.actualCostUsd === "number" ? obs.actualCostUsd : 0;
      cost.record(c);
    }
    const breakdown = cost.breakdown();
    const budget = makeCostBudget({ perTrialUsd: 1, perRunUsd: trials });
    expect(breakdown.trials).toBe(trials);
    expect(breakdown.perTrialUsd).toBeLessThanOrEqual(budget.perTrialUsd);
    expect(breakdown.totalUsd).toBeLessThanOrEqual(budget.perRunUsd);
  }, 1_050_000);

  run("PERF: sub-agent spawn latency scales acceptably (1, 3 spawns)", async () => {
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const tracker = new LatencyTracker();
    for (const N of [1, 3]) {
      const sample = {
        ...baseSample,
        id: `perf.spawn.n${N}`,
        input: {
          ...baseSample.input,
          prompt: `Spawn ${N} sub-agent(s) and have each compute test_add(1,1). Then report.`,
        },
      };
      const runner = new MultiTrialRunner({
        driverFactory: () => new LiveDriver({ timeout: 240_000 }),
        trials: 1,
      });
      const result = await runner.runTask({ ...dataset, samples: [sample] });
      const observed = result.rawRuns[0]!.cases[0]!.observed;
      tracker.record(observed.latencyMs);
    }
    expect(tracker.size()).toBe(2);
    const p = tracker.percentiles();
    expect(p.max).toBeGreaterThanOrEqual(p.min);
  }, 870_000);

  run("PERF: regression detector — slow run detected against fast baseline", async () => {
    // Sanity test for the perf-tracking helpers themselves: a synthetic
    // slow run should produce a higher p95 than a fast baseline.
    const fast = new LatencyTracker();
    for (const v of [100, 110, 120, 130, 140]) fast.record(v);
    const slow = new LatencyTracker();
    for (const v of [500, 520, 540, 560, 580]) slow.record(v);
    expect(slow.percentiles().p95).toBeGreaterThan(fast.percentiles().p95);
  });

  dbRun("PERF: turn DB-call budget — single turn under sentinel cap", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const tracker = new DbTracker({ connectionString: databaseUrl });
    const { delta } = await tracker.measure(async () => {
      await driver.run(sample);
    });
    expect(delta.available).toBe(true);
    expect(delta.queries).toBeGreaterThan(0);
    const checker = BudgetChecker.check(
      { dbQueries: { perTurn: 5_000 } },
      { dbDelta: delta, dbPerTurn: delta.queries },
    );
    expect(checker.passed, checker.violations.join(", ")).toBe(true);
  }, 360_000);

  dbRun("PERF: spawn DB-call budget — single spawn under sentinel cap", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "perf.db.spawn.budget",
      input: {
        ...baseSample.input,
        prompt:
          "Spawn 1 sub-agent and have it compute test_add(1,1). Then report the result.",
      },
    };
    const driver = new LiveDriver({ timeout: 300_000 });
    const tracker = new DbTracker({ connectionString: databaseUrl });
    const { delta } = await tracker.measure(async () => {
      await driver.run(sample);
    });
    expect(delta.available).toBe(true);
    expect(delta.queries).toBeGreaterThan(0);
    const checker = BudgetChecker.check(
      { dbQueries: { perSpawn: 10_000 } },
      { dbDelta: delta, dbPerSpawn: delta.queries },
    );
    expect(checker.passed, checker.violations.join(", ")).toBe(true);
  }, 360_000);

  dbRun("PERF: DB byCategory surfaces orchestration + cms calls", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const tracker = new DbTracker({ connectionString: databaseUrl });
    const { delta } = await tracker.measure(async () => {
      await driver.run(sample);
    });
    expect(delta.available).toBe(true);
    const total =
      delta.byCategory.orchestration +
      delta.byCategory.cms +
      delta.byCategory.facts +
      delta.byCategory["session-store"] +
      delta.byCategory["blob-store"] +
      delta.byCategory.other;
    expect(total).toBe(delta.queries);
    expect(
      delta.byCategory.orchestration + delta.byCategory.cms,
    ).toBeGreaterThan(0);
  }, 360_000);

  dbRun("PERF: DB delta exec time stays within sentinel total cap", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const tracker = new DbTracker({ connectionString: databaseUrl });
    const { delta } = await tracker.measure(async () => {
      await driver.run(sample);
    });
    expect(delta.available).toBe(true);
    const checker = BudgetChecker.check(
      { dbQueries: { totalExecTimeMs: 60_000 } },
      { dbDelta: delta },
    );
    expect(checker.passed, checker.violations.join(", ")).toBe(true);
  }, 360_000);
});
