# Performance suite

How to use the trackers in `src/perf/` to measure latency, cost, DB-call budget, peak memory / connection, durability percentiles, and concurrency scaling.

## Trackers at a glance

| tracker | source | what it measures | requires |
|---------|--------|------------------|----------|
| `LatencyTracker` | `latency-tracker.ts` | p50 / p95 / p99 over recorded sample latencies | nothing |
| `CostTracker` | `cost-tracker.ts` | cumulative cost across recorded trials | per-call cost (from observed.actualCostUsd or JudgeCost) |
| `ResourceTracker` | `resource-tracker.ts` | peak RSS, before/after deltas via `startMemoryWatch / stopMemoryWatch` | nothing |
| `PgActivityPoller` | `pg-activity-poller.ts` | sampled `pg_stat_activity` connection peak during a span | DATABASE_URL |
| `DbTracker` | `db-tracker.ts` | per-statement query counts + total exec time around a measured op | `pg_stat_statements` extension |
| `DurabilityTracker` | `durability-tracker.ts` | dehydrate / hydrate / handoff percentiles from CMS events | LiveDriver `observed.cmsEvents` |
| `ConcurrencyProfiler` | `concurrency-profiler.ts` | scaling factor + per-level throughput across N parallel sessions | LiveDriver factory |
| `BudgetChecker` | `perf-budget.ts` | one-stop assertion: "did we stay under these budgets" | the trackers above |

`BudgetChecker.check(budgets, observed)` returns `{ passed, violations }` so a single `expect(checker.passed).toBe(true)` covers the whole performance envelope.

## LatencyTracker — wallclock percentiles

```ts
import { LatencyTracker } from "pilotswarm-eval-harness";

const tracker = new LatencyTracker();
for (const r of multiTrialResult.rawRuns) {
  tracker.record(r.cases[0]!.observed.latencyMs);
}
const p = tracker.percentiles();
// { count, p50, p95, p99, mean, max }
```

Default budgets in `test/performance-live.test.ts`:

```ts
makeLatencyBudget({ p50Ms: 60_000, p95Ms: 180_000, p99Ms: 240_000 });
```

## CostTracker — cumulative spend

```ts
import { CostTracker } from "pilotswarm-eval-harness";
const cost = new CostTracker();
for (const r of result.rawRuns) {
  const obs = r.cases[0]!.observed as { actualCostUsd?: number };
  cost.record(typeof obs.actualCostUsd === "number" ? obs.actualCostUsd : 0);
}
// cost.total(), cost.percentiles(), cost.mean()
```

Wire into `CIGate.maxCostUsd` to fail PRs that exceed the spend envelope.

## ResourceTracker — peak RSS

```ts
import { ResourceTracker } from "pilotswarm-eval-harness";

const resource = new ResourceTracker();
resource.startMemoryWatch(250);          // poll every 250ms
const before = resource.snapshotMemory();
try {
  await driver.run(sample);
} finally {
  const watch = resource.stopMemoryWatch();   // ALWAYS in finally
  const after = resource.snapshotMemory();
  const delta = ResourceTracker.deltaMB(before, after);
  // watch.peakRssMB, watch.samples[], delta.rssMB
}
```

Default budget: `peakRssMB: 4_096` (per `perf-resource-live.test.ts`).

## PgActivityPoller — connection peak

Polls `pg_stat_activity` at `intervalMs` cadence around a span:

```ts
import { PgActivityPoller } from "pilotswarm-eval-harness";

const poller = new PgActivityPoller({
  connectionString: process.env.DATABASE_URL!,
  intervalMs: 200,
});
await poller.start();
try {
  await driver.run(sample);
} finally {
  const activity = await poller.stop();
  // activity.samples[], activity.peakConnections
}
```

Counts ALL connections to the cluster (not filtered by application or database), so under `--parallel-files` the peak gets contaminated by sibling test files. The peak-conn budget skips when `PS_EVAL_FILE_PARALLELISM=1`.

## DbTracker — pg_stat_statements deltas

`pg_stat_statements` records every statement's call count and total exec time per (userid, dbid, queryid). DbTracker snapshots before+after, diffs, categorizes.

```ts
import { DbTracker } from "pilotswarm-eval-harness";

const tracker = new DbTracker({ connectionString: process.env.DATABASE_URL });
const { delta } = await tracker.measure(async () => {
  await driver.run(sample);
});

// delta.available, delta.queries, delta.totalExecTimeMs, delta.byCategory, delta.topN
```

**Isolation rules — load-bearing:**

- `pg_stat_statements` is cluster-wide. DbTracker filters its snapshot to `current_database()` (commit `86bbf1a`) so sibling apps on the same Postgres don't pollute counts.
- Snapshot is still time-windowed across the `measure()` call. **If multiple test files run concurrently against the same database, every file's queries show up in every file's delta.** Skip DB-budget tests when `PS_EVAL_FILE_PARALLELISM=1` (already wired).
- `precheckPgStatStatements()` returns `{ available, reason }`. Tests that *must* assert call this and fail loudly on missing extension instead of silently passing — `PG_STAT_STATEMENTS_ENABLED=1` is the gate.

Default budgets:

| budget | value |
|---|---|
| `dbQueries.perTurn` | 5_000 |
| `dbQueries.perSpawn` | 10_000 |
| `dbQueries.totalExecTimeMs` | 60_000 |

Real run observed 47k–111k queries, 9–11× over these budgets — that's a PilotSwarm SDK signal worth profiling, not a budget to relax.

## DurabilityTracker — dehydrate/hydrate/handoff percentiles

Reads CMS event log (from `observed.cmsEvents`) and computes percentiles for:

- `dehydrate` — time from request to `session.dehydrate_complete`
- `hydrate` — time to `session.hydrate_complete`
- `handoff` — time from worker A stop to first worker B activity on the same session
- `replay` — time inside hydrate spent re-running prior turns

```ts
import { DurabilityTracker } from "pilotswarm-eval-harness";

const tracker = new DurabilityTracker();
for (const event of observed.cmsEvents) tracker.recordCmsEvent(event);
const p = tracker.percentilesByPhase();
// { dehydrate: { measured, p50, p95 }, hydrate: {...}, handoff: {...}, replay: {...} }
```

Buckets carry `measured: boolean` — false means "no SDK hook / no CMS events / no harness measurement." Treat zero as unmeasured, not as a clean zero. `recordWallClock(phase, ms)` is the harness fallback when SDK events aren't yet emitted.

## ConcurrencyProfiler — scaling factor

Runs N parallel LiveDriver sessions and computes throughput vs single-session baseline.

```ts
import { ConcurrencyProfiler } from "pilotswarm-eval-harness";

const profiler = new ConcurrencyProfiler({
  driverFactory: () => new LiveDriver({ timeout: 300_000 }),
  levels: [1, 4, 7],            // sessions per level
  trialsPerLevel: 3,
  capacityGuard: { maxConnections: 60 }, // pre-flight PG conn count check
});
const profile = await profiler.run(sample);
// profile.byLevel[], profile.scalingFactor — throughput(N) / (N × throughput(1))
```

Capacity guard pre-flights `pg_stat_activity` to refuse running if cluster doesn't have headroom. Avoids self-DDoS.

`PERF_HEAVY_N8=1` raises the top level from 7 to 15 sessions. DB-connection heavy — use only on bumped Postgres (`max_connections >= 200`).

## BudgetChecker — one-stop assertion

```ts
import { BudgetChecker } from "pilotswarm-eval-harness";

const checker = BudgetChecker.check(
  {
    resource: { peakRssMB: 4_096, peakConnections: 200 },
    dbQueries: { perTurn: 5_000, totalExecTimeMs: 60_000 },
  },
  {
    resource: { memory: watch, activity },
    dbDelta: delta,
    dbPerTurn: delta.queries,
  },
);
expect(checker.passed, checker.violations.join(", ")).toBe(true);
```

Violations come back as strings shaped `"<dimension>: observed N > budget M"` so the assertion message points at the failing dimension.

## Authoring a new perf test

1. Pick the trackers that match your dimension (latency? cost? DB?).
2. Wrap them around a `driver.run()` (or `MultiTrialRunner` for percentiles).
3. Pass results to `BudgetChecker.check({budgets}, {observed})`.
4. Gate on environment: `LIVE=1`, plus `PG_STAT_STATEMENTS_ENABLED=1` if you assert DB budgets.
5. Add an `isolated` guard if your measurement is contaminated by parallel files.
6. Set per-`it` timeout big enough for the worst-case envelope.

Reference patterns in `test/performance-live.test.ts` and `test/perf-resource-live.test.ts`.

## Common mistakes

- **DB budgets without isolation:** under `--parallel-files`, you measure every file at once. Skip when not isolated.
- **Counting on capacity:** don't run heavy concurrency without `capacityGuard` — you'll OOM the DB or saturate `max_connections`.
- **Recording cost from a model that didn't bill:** if `observed.actualCostUsd` is undefined, record 0 not skip. Otherwise you under-count and `CIGate.maxCostUsd` lies.
- **Asserting peak RSS without `finally`:** if `driver.run()` throws, `stopMemoryWatch()` never fires and the watch leaks an interval. Always use `try/finally`.
- **Single-call latency assertions:** measure across N trials with `LatencyTracker.percentiles()` — one call's `latencyMs` is a sample of one.

## Pointers

- `src/perf/` — implementations
- `src/perf/index.ts` — public exports
- `test/performance-live.test.ts` — latency, cost, DB-budget patterns
- `test/perf-resource-live.test.ts` — RSS, connections, DB-resource
- `test/perf-concurrency-live.test.ts` — concurrency profiler
- `test/perf-durability-live.test.ts` — durability percentile tracker
- `test/perf-cold-warm-live.test.ts` — cold vs warm session timing
