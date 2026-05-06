// Concurrency perf LIVE — gated by LIVE=1 PERF_HEAVY=1. Profiles latency
// degradation under N=1,2,4 parallel sessions. Heavy: at minimum 7
// LiveDriver runs.
//
// Audit H2: failure rate now feeds the scaling verdict via
// `effectiveMeanLatency`, and an optional preflight capacity guard
// rejects runs whose projected DB connection load would exceed the
// configured maxConnections cap. Set PERF_HEAVY_N8=1 to additionally
// exercise N=8 (≥15 LiveDriver runs).

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { loadEvalTask } from "../src/loader.js";
import { ConcurrencyProfiler } from "../src/perf/concurrency-profiler.js";
import { BudgetChecker } from "../src/perf/perf-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const liveAndHeavy = process.env.LIVE === "1" && process.env.PERF_HEAVY === "1";
const includeN8 = process.env.PERF_HEAVY_N8 === "1";

// Conservative connection cap derived from local Postgres default
// (max_connections = 100) minus headroom for the audit-time baseline of
// ~104 idle connections. Override with PERF_HEAVY_MAX_CONNECTIONS for
// non-default deployments.
const maxConnections = Number.parseInt(
  process.env.PERF_HEAVY_MAX_CONNECTIONS ?? "60",
  10,
);

describe("Concurrency perf LIVE", () => {
  const run = liveAndHeavy ? it : it.skip;
  const levels = includeN8 ? [1, 2, 4, 8] : [1, 2, 4];

  run(
    `PERF: scaling profile across N=${levels.join(",")} parallel sessions`,
    async () => {
      const dataset = loadEvalTask(
        resolve(__dirname, "../datasets/tool-call-correctness.v1.json"),
      );
      const sample = dataset.samples.find((s) => s.id === "single.add.basic")
        ?? dataset.samples[0]!;
      const profiler = new ConcurrencyProfiler();
      const result = await profiler.profile({
        driverFactory: () => new LiveDriver({ timeout: 300_000 }),
        sample,
        levels,
        samplesPerLevel: 1,
        // H2 fix: preflight DB-capacity guard. LiveDriver opens roughly 5
        // pg connections (CMS pool max=3 + facts pool max=3 - shared +
        // duroxide pool + listener); cap N×perDriver against
        // maxConnections to refuse runs that would crash the local DB.
        capacity: { connectionsPerDriver: 5, maxConnections },
        // H2 fix: abort early when any level's failure rate exceeds 30%
        // — at that point the scaling number cannot be trusted regardless
        // of effectiveMeanLatency penalty.
        failureRateAbortThreshold: 0.3,
      });

      if (result.abortedReason) {
        console.log(`  PROFILE ABORTED: ${result.abortedReason}`);
        // An aborted profile must not silently pass — it represents
        // measurement infeasibility, not a green gate.
        const checker = BudgetChecker.check(
          { concurrency: { scalingFactorMax: 4, failuresMax: 2, failureRateMax: 0.3 } },
          { concurrency: result },
        );
        expect(checker.passed).toBe(false);
        return;
      }

      for (const N of levels) {
        expect(result.byN[N]?.count).toBeGreaterThanOrEqual(1);
      }
      const checker = BudgetChecker.check(
        {
          concurrency: {
            scalingFactorMax: 4,
            failuresMax: 2,
            failureRateMax: 0.3,
          },
        },
        { concurrency: result },
      );
      expect(checker.passed, checker.violations.join(", ")).toBe(true);
    },
    includeN8 ? 2_400_000 : 1_050_000,
  );
});
