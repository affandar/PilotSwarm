// Resource perf LIVE — gated by LIVE=1. Measures memory peak, postgres
// connection peak, and pg_stat_statements query delta around a single
// LiveDriver run.
//
// Audit B1 fix: DB-budget tests no longer return-early on missing
// pg_stat_statements. They precheck the extension and skip with a clear
// reason gate (PG_STAT_STATEMENTS_ENABLED=1 forces fail-loud mode), so
// the gate cannot quietly pass with zero DB signal.
//
// Audit H5 fix: stopMemoryWatch() is now in a try/finally so it always
// runs even when driver.run() throws.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { loadEvalTask } from "../src/loader.js";
import { ResourceTracker } from "../src/perf/resource-tracker.js";
import { PgActivityPoller } from "../src/perf/pg-activity-poller.js";
import {
  DbTracker,
  PgStatStatementsRequiredError,
} from "../src/perf/db-tracker.js";
import { BudgetChecker } from "../src/perf/perf-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const live = process.env.LIVE === "1";
const strictPgStat = process.env.PG_STAT_STATEMENTS_ENABLED === "1";
// pg_stat_statements is database-global. When file parallelism is on,
// concurrent test files pollute each other's snapshots — DB-call counts
// and peak-connection observations both reflect cluster-wide load, not
// the cell under measurement. Skip those budgets when running parallel.
const isolated =
  process.env.PS_EVAL_FILE_PARALLELISM !== "1";

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/pilotswarm";

async function precheckPgStat(): Promise<{ ok: boolean; reason?: string }> {
  const tracker = new DbTracker({ connectionString: databaseUrl });
  const r = await tracker.precheckPgStatStatements();
  return { ok: r.available, reason: r.reason };
}

describe("Resource perf LIVE", () => {
  const run = live ? it : it.skip;
  // Reaudit G4 fix: DB-budget tests now skip via Vitest when LIVE=1 but
  // PG_STAT_STATEMENTS_ENABLED is not set, instead of silently passing
  // after a `console.log("SKIP: ...")`.
  const dbRun = (live && strictPgStat && isolated) ? it : it.skip;
  // Peak-connections asserts max concurrent conns ≤ budget, but with
  // file parallelism every other test file's pool conns count too.
  const isolatedRun = (live && isolated) ? it : it.skip;

  run("PERF: peak RSS memory during single-turn run within budget", async () => {
    const dataset = loadEvalTask(
      resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
    );
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const resource = new ResourceTracker();
    resource.startMemoryWatch(250);
    const before = resource.snapshotMemory();
    let watch;
    try {
      await driver.run(sample);
    } finally {
      // H5 fix: always stop the watch even if driver.run threw.
      watch = resource.stopMemoryWatch();
    }
    const after = resource.snapshotMemory();
    expect(watch.samples.length).toBeGreaterThan(0);
    expect(watch.peakRssMB).toBeGreaterThan(0);
    const delta = ResourceTracker.deltaMB(before, after);
    expect(delta).toBeTruthy();
    // Surface before/after RSS deltas so reviewers see the full picture.
    console.log(
      `  rss before=${before.rssMB.toFixed(1)}MB after=${after.rssMB.toFixed(1)}MB peak=${watch.peakRssMB.toFixed(1)}MB delta=${delta.rssMB.toFixed(1)}MB`,
    );

    const checker = BudgetChecker.check(
      { resource: { peakRssMB: 4_096 } },
      { resource: { memory: watch } },
    );
    expect(checker.passed, checker.violations.join(", ")).toBe(true);
  }, 360_000);

  isolatedRun("PERF: postgres connection peak during single-turn run within budget", async () => {
    const dataset = loadEvalTask(
      resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
    );
    const sample = dataset.samples[0]!;
    const driver = new LiveDriver({ timeout: 300_000 });
    const poller = new PgActivityPoller({
      connectionString: databaseUrl,
      intervalMs: 200,
    });
    await poller.start();
    try {
      await driver.run(sample);
    } finally {
      const activity = await poller.stop();
      expect(activity.samples.length).toBeGreaterThan(0);
      const checker = BudgetChecker.check(
        { resource: { peakConnections: 200 } },
        { resource: { activity } },
      );
      expect(checker.passed, checker.violations.join(", ")).toBe(true);
    }
  }, 360_000);

  dbRun("PERF: turn DB-call budget", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(
      resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
    );
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

  dbRun("PERF: spawn DB-call budget", async () => {
    const pre = await precheckPgStat();
    if (!pre.ok) {
      throw new PgStatStatementsRequiredError(pre.reason ?? "unknown");
    }
    const dataset = loadEvalTask(
      resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
    );
    const baseSample = dataset.samples[0]!;
    const sample = {
      ...baseSample,
      id: "perf.db.spawn",
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
});
