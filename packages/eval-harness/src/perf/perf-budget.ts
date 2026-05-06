/**
 * Unified perf budget covering latency, cost, DB, durability, resource,
 * and concurrency dimensions.
 *
 * Audit fix B2 — fail-closed semantics:
 *   A configured budget dimension REQUIRES the corresponding measurement
 *   in `report`. If the measurement is missing or unavailable, the dim
 *   produces a violation rather than silently passing. Callers that
 *   genuinely cannot measure a dimension may opt-out per-budget by
 *   setting `optional: true`.
 *
 * Audit fix H7 — baseline comparison:
 *   `BaselineComparator.compare()` checks the current report against a
 *   recorded historical baseline (e.g. `datasets/prompt-baselines/perf-baseline.v1.json`)
 *   using a relative regression tolerance (default 1.5x), catching
 *   doublings that sentinel caps would not.
 */

import type { CostBreakdown, LatencyPercentiles } from "./latency-tracker.js";
import type { DbCallDelta } from "./db-tracker.js";
import type {
  DurabilityPercentiles,
  TrackerPercentiles,
} from "./durability-tracker.js";
import type { ConcurrencyProfile } from "./concurrency-profiler.js";
import type { MemoryWatchResult } from "./resource-tracker.js";
import type { PgActivityResult } from "./pg-activity-poller.js";

/**
 * Common per-dimension options. Set `optional: true` to revert to the
 * pre-audit "skip if missing" behavior — the dim then passes silently
 * when no report data is present, but still fails on threshold violations
 * if data IS present.
 */
export interface OptionalDim {
  optional?: boolean;
}

export interface LatencyBudgetShape extends OptionalDim {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CostBudgetShape extends OptionalDim {
  perTrialUsd: number;
  perRunUsd: number;
  perTaskUsd?: number;
}

export interface DbBudget extends OptionalDim {
  perTurn?: number;
  perSpawn?: number;
  perSweep?: number;
  totalQueries?: number;
  totalExecTimeMs?: number;
}

export interface DurabilityBudget extends OptionalDim {
  rehydrateP95Ms?: number;
  replayP95Ms?: number;
  checkpointP95Ms?: number;
  dehydrateP95Ms?: number;
}

export interface ResourceBudget extends OptionalDim {
  peakRssMB?: number;
  peakConnections?: number;
}

export interface ConcurrencyBudgetShape extends OptionalDim {
  scalingFactorMax?: number;
  failuresMax?: number;
  /** Reject when any level's failureRate exceeds this fraction (0-1). */
  failureRateMax?: number;
}

export interface PerfBudget {
  latency?: LatencyBudgetShape;
  cost?: CostBudgetShape;
  dbQueries?: DbBudget;
  durability?: DurabilityBudget;
  resource?: ResourceBudget;
  concurrency?: ConcurrencyBudgetShape;
}

/** Snapshot of measured perf data for use by BudgetChecker / Reporter. */
export interface PerfReport {
  latency?: LatencyPercentiles;
  cost?: CostBreakdown;
  dbDelta?: DbCallDelta;
  dbPerTurn?: number;
  dbPerSpawn?: number;
  dbPerSweep?: number;
  durability?: DurabilityPercentiles;
  resource?: {
    memory?: MemoryWatchResult;
    activity?: PgActivityResult;
  };
  concurrency?: ConcurrencyProfile;
  /**
   * Optional advertised dimensions that the harness does not yet measure
   * with first-class signal. Surfaced by the reporter so consumers see
   * the gap explicitly instead of silent absence.
   */
  toolCallLatency?: { available: false; unavailableReason: string }
    | { available: true; perToolMs: Record<string, TrackerPercentiles> };
  cleanupRate?: { available: false; unavailableReason: string }
    | { available: true; sessionsPerMinute: number; sample: number };
  coldVsWarm?: { available: false; unavailableReason: string }
    | {
        available: true;
        cold: TrackerPercentiles;
        warm: TrackerPercentiles;
      };
  meta?: Record<string, unknown>;
}

export interface BudgetCheckResult {
  passed: boolean;
  violations: string[];
  details: Array<{ dim: string; passed: boolean; reason?: string }>;
}

function pushViolation(
  out: BudgetCheckResult,
  dim: string,
  reason: string,
): void {
  out.details.push({ dim, passed: false, reason });
  out.violations.push(`${dim}: ${reason}`);
}

function pushPass(out: BudgetCheckResult, dim: string): void {
  out.details.push({ dim, passed: true });
}

function checkPercentiles(
  label: string,
  budget: LatencyBudgetShape,
  observed: { p50: number; p95: number; p99: number },
  out: BudgetCheckResult,
): void {
  for (const key of ["p50Ms", "p95Ms", "p99Ms"] as const) {
    const lim = budget[key];
    const obsKey = key.replace("Ms", "") as "p50" | "p95" | "p99";
    const obs = observed[obsKey];
    if (obs <= lim) {
      pushPass(out, `${label}.${key}`);
    } else {
      pushViolation(
        out,
        `${label}.${key}`,
        `observed ${obs.toFixed(2)} > budget ${lim}`,
      );
    }
  }
}

function checkP95(
  label: string,
  limit: number | undefined,
  observed: TrackerPercentiles | undefined,
  out: BudgetCheckResult,
  optional: boolean,
): void {
  if (limit == null) return;
  if (!observed) {
    if (optional) return;
    pushViolation(out, label, "configured but no measurement present");
    return;
  }
  if (!observed.available) {
    if (optional) return;
    pushViolation(
      out,
      label,
      `measurement unavailable: ${observed.unavailableReason ?? "unknown"}`,
    );
    return;
  }
  if (observed.count === 0) {
    if (optional) return;
    pushViolation(out, label, "configured but zero samples recorded");
    return;
  }
  if (observed.p95 <= limit) {
    pushPass(out, label);
  } else {
    pushViolation(out, label, `observed p95 ${observed.p95.toFixed(2)} > budget ${limit}`);
  }
}

export class BudgetChecker {
  static check(budget: PerfBudget, report: PerfReport): BudgetCheckResult {
    const out: BudgetCheckResult = { passed: true, violations: [], details: [] };

    // ── latency ──
    if (budget.latency) {
      const optional = budget.latency.optional === true;
      if (!report.latency) {
        if (!optional) pushViolation(out, "latency", "configured but report.latency missing");
      } else if (report.latency.count === 0) {
        if (!optional) pushViolation(out, "latency", "configured but zero samples recorded");
      } else {
        checkPercentiles("latency", budget.latency, report.latency, out);
      }
    }

    // ── cost ──
    if (budget.cost) {
      const optional = budget.cost.optional === true;
      const c = report.cost;
      if (!c) {
        if (!optional) pushViolation(out, "cost", "configured but report.cost missing");
      } else {
        const b = budget.cost;
        if (b.perTrialUsd != null) {
          if (c.perTrialUsd <= b.perTrialUsd) pushPass(out, "cost.perTrialUsd");
          else
            pushViolation(
              out,
              "cost.perTrialUsd",
              `observed ${c.perTrialUsd.toFixed(4)} > budget ${b.perTrialUsd}`,
            );
        }
        if (b.perRunUsd != null) {
          if (c.totalUsd <= b.perRunUsd) pushPass(out, "cost.perRunUsd");
          else
            pushViolation(
              out,
              "cost.perRunUsd",
              `observed ${c.totalUsd.toFixed(4)} > budget ${b.perRunUsd}`,
            );
        }
      }
    }

    // ── dbQueries ──
    if (budget.dbQueries) {
      const optional = budget.dbQueries.optional === true;
      const b = budget.dbQueries;
      const deltaUnavailable = report.dbDelta && !report.dbDelta.available;

      const requiresDelta = b.totalQueries != null || b.totalExecTimeMs != null;
      const requiresPerTurn = b.perTurn != null;
      const requiresPerSpawn = b.perSpawn != null;
      const requiresPerSweep = b.perSweep != null;

      if (deltaUnavailable && (requiresDelta || requiresPerTurn || requiresPerSpawn || requiresPerSweep)) {
        if (!optional) {
          pushViolation(
            out,
            "dbQueries",
            `pg_stat_statements unavailable: ${report.dbDelta?.unavailableReason ?? "unknown"}`,
          );
        }
      } else {
        if (requiresPerTurn) {
          if (report.dbPerTurn == null) {
            if (!optional) pushViolation(out, "dbQueries.perTurn", "configured but report.dbPerTurn missing");
          } else if (report.dbPerTurn <= b.perTurn!) pushPass(out, "dbQueries.perTurn");
          else
            pushViolation(
              out,
              "dbQueries.perTurn",
              `observed ${report.dbPerTurn} > budget ${b.perTurn}`,
            );
        }
        if (requiresPerSpawn) {
          if (report.dbPerSpawn == null) {
            if (!optional) pushViolation(out, "dbQueries.perSpawn", "configured but report.dbPerSpawn missing");
          } else if (report.dbPerSpawn <= b.perSpawn!) pushPass(out, "dbQueries.perSpawn");
          else
            pushViolation(
              out,
              "dbQueries.perSpawn",
              `observed ${report.dbPerSpawn} > budget ${b.perSpawn}`,
            );
        }
        if (requiresPerSweep) {
          if (report.dbPerSweep == null) {
            if (!optional) pushViolation(out, "dbQueries.perSweep", "configured but report.dbPerSweep missing");
          } else if (report.dbPerSweep <= b.perSweep!) pushPass(out, "dbQueries.perSweep");
          else
            pushViolation(
              out,
              "dbQueries.perSweep",
              `observed ${report.dbPerSweep} > budget ${b.perSweep}`,
            );
        }
        if (b.totalQueries != null) {
          if (!report.dbDelta) {
            if (!optional) pushViolation(out, "dbQueries.totalQueries", "configured but report.dbDelta missing");
          } else if (report.dbDelta.queries <= b.totalQueries) pushPass(out, "dbQueries.totalQueries");
          else
            pushViolation(
              out,
              "dbQueries.totalQueries",
              `observed ${report.dbDelta.queries} > budget ${b.totalQueries}`,
            );
        }
        if (b.totalExecTimeMs != null) {
          if (!report.dbDelta) {
            if (!optional) pushViolation(out, "dbQueries.totalExecTimeMs", "configured but report.dbDelta missing");
          } else if (report.dbDelta.execTimeMs <= b.totalExecTimeMs) pushPass(out, "dbQueries.totalExecTimeMs");
          else
            pushViolation(
              out,
              "dbQueries.totalExecTimeMs",
              `observed ${report.dbDelta.execTimeMs.toFixed(2)} > budget ${b.totalExecTimeMs}`,
            );
        }
      }
    }

    // ── durability ──
    if (budget.durability) {
      const optional = budget.durability.optional === true;
      if (!report.durability) {
        if (!optional) pushViolation(out, "durability", "configured but report.durability missing");
      } else {
        checkP95("durability.rehydrate", budget.durability.rehydrateP95Ms, report.durability.rehydrate, out, optional);
        checkP95("durability.replay", budget.durability.replayP95Ms, report.durability.replay, out, optional);
        checkP95("durability.checkpoint", budget.durability.checkpointP95Ms, report.durability.checkpoint, out, optional);
        checkP95("durability.dehydrate", budget.durability.dehydrateP95Ms, report.durability.dehydrate, out, optional);
      }
    }

    // ── resource ──
    if (budget.resource) {
      const optional = budget.resource.optional === true;
      const b = budget.resource;
      if (b.peakRssMB != null) {
        const mem = report.resource?.memory;
        if (!mem) {
          if (!optional) pushViolation(out, "resource.peakRssMB", "configured but report.resource.memory missing");
        } else if (mem.peakRssMB <= b.peakRssMB) pushPass(out, "resource.peakRssMB");
        else
          pushViolation(
            out,
            "resource.peakRssMB",
            `observed ${mem.peakRssMB.toFixed(2)} > budget ${b.peakRssMB}`,
          );
      }
      if (b.peakConnections != null) {
        const act = report.resource?.activity;
        if (!act) {
          if (!optional) pushViolation(out, "resource.peakConnections", "configured but report.resource.activity missing");
        } else if (act.peak <= b.peakConnections) pushPass(out, "resource.peakConnections");
        else
          pushViolation(
            out,
            "resource.peakConnections",
            `observed ${act.peak} > budget ${b.peakConnections}`,
          );
      }
    }

    // ── concurrency ──
    if (budget.concurrency) {
      const optional = budget.concurrency.optional === true;
      const b = budget.concurrency;
      if (!report.concurrency) {
        if (!optional) pushViolation(out, "concurrency", "configured but report.concurrency missing");
      } else {
        if (report.concurrency.abortedReason) {
          // A profile that aborted (capacity guard or failure threshold)
          // cannot pass any concurrency dim — surface the reason.
          //
          // Caveat (audit B2 caveat, intentional): if the caller marked
          // the concurrency budget as `optional: true`, an aborted
          // profile is silently accepted. This is consistent with the
          // documented opt-out semantics of `OptionalDim` — `optional`
          // means "if I can't measure this, don't fail the gate" — but
          // it does mean an aborted profile + `optional: true` cannot
          // produce a violation. Set `optional: false` (or omit) on
          // any concurrency budget where you want abort detection to
          // hard-fail the gate.
          if (!optional)
            pushViolation(
              out,
              "concurrency",
              `profile aborted: ${report.concurrency.abortedReason}`,
            );
        } else {
          if (b.scalingFactorMax != null) {
            if (report.concurrency.scalingFactor <= b.scalingFactorMax) pushPass(out, "concurrency.scalingFactor");
            else
              pushViolation(
                out,
                "concurrency.scalingFactor",
                `observed ${report.concurrency.scalingFactor.toFixed(2)} > budget ${b.scalingFactorMax}`,
              );
          }
          if (b.failuresMax != null) {
            const totalFailures = Object.values(report.concurrency.byN).reduce(
              (acc, v) => acc + v.failures,
              0,
            );
            if (totalFailures <= b.failuresMax) pushPass(out, "concurrency.failuresMax");
            else
              pushViolation(
                out,
                "concurrency.failuresMax",
                `observed ${totalFailures} > budget ${b.failuresMax}`,
              );
          }
          if (b.failureRateMax != null) {
            const worst = Object.values(report.concurrency.byN).reduce(
              (acc, v) => Math.max(acc, v.failureRate),
              0,
            );
            if (worst <= b.failureRateMax) pushPass(out, "concurrency.failureRateMax");
            else
              pushViolation(
                out,
                "concurrency.failureRateMax",
                `worst level failureRate ${worst.toFixed(2)} > budget ${b.failureRateMax}`,
              );
          }
        }
      }
    }

    out.passed = out.violations.length === 0;
    return out;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Baseline comparison (H7)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Persisted baseline shape — written under `datasets/prompt-baselines/` and loaded
 * by `BaselineComparator.compare()` for relative regression detection.
 */
export interface PerfBaseline {
  version: string;
  capturedAt: string;
  description?: string;
  metrics: {
    latencyP95Ms?: number;
    latencyP50Ms?: number;
    costPerTrialUsd?: number;
    dbPerTurn?: number;
    dbPerSpawn?: number;
    dbTotalQueries?: number;
    dbTotalExecTimeMs?: number;
    rehydrateP95Ms?: number;
    dehydrateP95Ms?: number;
    peakRssMB?: number;
    peakConnections?: number;
    concurrencyScalingFactor?: number;
  };
}

export interface BaselineComparisonOptions {
  /** Multiplicative tolerance for regression. e.g. 1.5 = fail at >150% of baseline. */
  tolerance?: number;
  /** Absolute floor below which deltas are ignored (avoids noise on small numbers). */
  absoluteFloor?: Partial<PerfBaseline["metrics"]>;
}

export class BaselineComparator {
  static compare(
    baseline: PerfBaseline,
    report: PerfReport,
    opts: BaselineComparisonOptions = {},
  ): BudgetCheckResult {
    const out: BudgetCheckResult = { passed: true, violations: [], details: [] };
    const tol = opts.tolerance ?? 1.5;
    const floor = opts.absoluteFloor ?? {};
    const m = baseline.metrics;

    const checkRel = (
      dim: string,
      base: number | undefined,
      observed: number | undefined,
      floorVal?: number,
    ): void => {
      if (base == null) return;
      if (observed == null || !Number.isFinite(observed)) {
        pushViolation(out, dim, `baseline=${base} but observed missing`);
        return;
      }
      // Skip when both are below the absolute floor — reduces noise.
      if (floorVal != null && base < floorVal && observed < floorVal) {
        pushPass(out, `${dim} (below floor ${floorVal})`);
        return;
      }
      const limit = base * tol;
      if (observed <= limit) {
        pushPass(out, dim);
      } else {
        pushViolation(
          out,
          dim,
          `observed ${observed.toFixed(2)} > baseline ${base.toFixed(2)} × ${tol} (= ${limit.toFixed(2)})`,
        );
      }
    };

    checkRel("baseline.latencyP50Ms", m.latencyP50Ms, report.latency?.p50, floor.latencyP50Ms);
    checkRel("baseline.latencyP95Ms", m.latencyP95Ms, report.latency?.p95, floor.latencyP95Ms);
    checkRel("baseline.costPerTrialUsd", m.costPerTrialUsd, report.cost?.perTrialUsd, floor.costPerTrialUsd);
    checkRel("baseline.dbPerTurn", m.dbPerTurn, report.dbPerTurn, floor.dbPerTurn);
    checkRel("baseline.dbPerSpawn", m.dbPerSpawn, report.dbPerSpawn, floor.dbPerSpawn);
    checkRel(
      "baseline.dbTotalQueries",
      m.dbTotalQueries,
      report.dbDelta?.available ? report.dbDelta.queries : undefined,
      floor.dbTotalQueries,
    );
    checkRel(
      "baseline.dbTotalExecTimeMs",
      m.dbTotalExecTimeMs,
      report.dbDelta?.available ? report.dbDelta.execTimeMs : undefined,
      floor.dbTotalExecTimeMs,
    );
    checkRel(
      "baseline.rehydrateP95Ms",
      m.rehydrateP95Ms,
      report.durability?.rehydrate.available ? report.durability.rehydrate.p95 : undefined,
      floor.rehydrateP95Ms,
    );
    checkRel(
      "baseline.dehydrateP95Ms",
      m.dehydrateP95Ms,
      report.durability?.dehydrate.available ? report.durability.dehydrate.p95 : undefined,
      floor.dehydrateP95Ms,
    );
    checkRel("baseline.peakRssMB", m.peakRssMB, report.resource?.memory?.peakRssMB, floor.peakRssMB);
    checkRel("baseline.peakConnections", m.peakConnections, report.resource?.activity?.peak, floor.peakConnections);
    checkRel(
      "baseline.concurrencyScalingFactor",
      m.concurrencyScalingFactor,
      report.concurrency?.scalingFactor,
      floor.concurrencyScalingFactor,
    );

    out.passed = out.violations.length === 0;
    return out;
  }
}
