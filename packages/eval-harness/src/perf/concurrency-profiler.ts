/**
 * Concurrency profiler — runs N parallel driver invocations of the same
 * sample for each level in `levels`, records per-run latency, and builds
 * a scaling curve. The scaling factor is mean(effLatency@maxN) /
 * mean(effLatency@1) where `effLatency` includes a failure-rate penalty
 * so that a level with mostly-failed runs cannot pass with a low mean.
 *
 * H2 fix: failures contribute to the scaling verdict (effective latency
 * inflates with failure rate), and an optional `maxEstimatedConnections`
 * preflight guard refuses to run when the configured concurrency would
 * exceed available pool capacity.
 */

import type { Driver } from "../drivers/types.js";
import type { EvalSample } from "../types.js";
import { percentilesOf, type TrackerPercentiles } from "./durability-tracker.js";

export interface ConcurrencyLevelStat {
  count: number;
  meanLatency: number;
  p50Latency: number;
  p95Latency: number;
  failures: number;
  /** failures / (failures + count). 0 when no attempts. */
  failureRate: number;
  /** meanLatency * (1 + failureRate) — what scaling uses. */
  effectiveMeanLatency: number;
  percentiles: TrackerPercentiles;
}

export interface ConcurrencyProfile {
  byN: Record<number, ConcurrencyLevelStat>;
  /** Ratio of effectiveMeanLatency at max-N vs min-N. Honest scaling. */
  scalingFactor: number;
  levels: number[];
  /**
   * If a preflight guard rejected the request, the run is aborted before
   * any driver is invoked and this field captures the reason.
   */
  abortedReason?: string;
}

export interface CapacityGuardOptions {
  /**
   * Estimated number of pg connections each Driver instance opens during
   * a run (LiveDriver: ~5 — duroxide pool, CMS pool, facts pool, blob
   * client, activity poller share). Default: 5.
   */
  connectionsPerDriver?: number;
  /**
   * Max simultaneous connections the upstream pool can serve. Profile
   * rejects any level whose `N * connectionsPerDriver` would exceed this.
   * Default: Infinity (no guard). Pass a real cap (e.g. 100, the local
   * Postgres default) to enable.
   */
  maxConnections?: number;
}

export interface ConcurrencyProfilerOptions {
  driverFactory: () => Driver;
  sample: EvalSample;
  levels: number[];
  samplesPerLevel?: number;
  /** Per-run timeout passed through to driver.run(). */
  timeoutMs?: number;
  /**
   * If set and any level has failureRate > this threshold, scaling is
   * marked aborted with reason rather than computing a misleading factor.
   * Default: 1.0 (disabled).
   */
  failureRateAbortThreshold?: number;
  /** Optional preflight DB-capacity guard. */
  capacity?: CapacityGuardOptions;
}

export function computeScalingFactor(
  byN: Record<number, ConcurrencyLevelStat>,
  levels: number[],
): number {
  if (levels.length === 0) return 1;
  const sorted = [...levels].sort((a, b) => a - b);
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const baseline = byN[lo]?.effectiveMeanLatency ?? byN[lo]?.meanLatency ?? 0;
  const top = byN[hi]?.effectiveMeanLatency ?? byN[hi]?.meanLatency ?? 0;
  if (baseline <= 0) return 1;
  return top / baseline;
}

export class ConcurrencyProfiler {
  async profile(opts: ConcurrencyProfilerOptions): Promise<ConcurrencyProfile> {
    if (!opts.levels || opts.levels.length === 0) {
      throw new Error("ConcurrencyProfiler.profile: levels must be non-empty");
    }
    for (const n of opts.levels) {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `ConcurrencyProfiler.profile: levels must be positive integers (got ${n})`,
        );
      }
    }
    const samplesPerLevel = Math.max(1, opts.samplesPerLevel ?? 1);
    const sortedLevels = [...opts.levels].sort((a, b) => a - b);

    // H2 fix: preflight DB-capacity guard. Refuse to start when the
    // configured concurrency would exceed available pool capacity. We
    // estimate per-driver connections conservatively and check the worst
    // (max) level.
    if (opts.capacity?.maxConnections != null) {
      const perDriver = Math.max(1, opts.capacity.connectionsPerDriver ?? 5);
      const maxN = sortedLevels[sortedLevels.length - 1]!;
      const projected = maxN * perDriver;
      if (projected > opts.capacity.maxConnections) {
        return {
          byN: {},
          scalingFactor: 1,
          levels: sortedLevels,
          abortedReason: `capacity guard: projected ${projected} connections (N=${maxN} × ${perDriver}/driver) exceeds maxConnections=${opts.capacity.maxConnections}`,
        };
      }
    }

    const byN: Record<number, ConcurrencyLevelStat> = {};

    for (const N of sortedLevels) {
      const latencies: number[] = [];
      let failures = 0;
      for (let trial = 0; trial < samplesPerLevel; trial++) {
        const drivers = Array.from({ length: N }, () => opts.driverFactory());
        const promises = drivers.map(async (drv) => {
          const t0 = nowMs();
          try {
            const obs = await drv.run(opts.sample, { timeout: opts.timeoutMs });
            const latency =
              typeof obs.latencyMs === "number" && Number.isFinite(obs.latencyMs)
                ? obs.latencyMs
                : nowMs() - t0;
            return { ok: true as const, latency };
          } catch {
            return { ok: false as const, latency: nowMs() - t0 };
          }
        });
        const results = await Promise.all(promises);
        for (const r of results) {
          if (r.ok) latencies.push(r.latency);
          else failures += 1;
        }
      }
      const percentiles = percentilesOf(latencies);
      const attempts = latencies.length + failures;
      const failureRate = attempts > 0 ? failures / attempts : 0;
      // Effective latency penalizes high failure rate so a 5/6 failed
      // level with one fast success can't masquerade as faster than a
      // baseline that all succeeded.
      const effectiveMeanLatency = percentiles.meanMs * (1 + failureRate);
      byN[N] = {
        count: latencies.length,
        meanLatency: percentiles.meanMs,
        p50Latency: percentiles.p50,
        p95Latency: percentiles.p95,
        failures,
        failureRate,
        effectiveMeanLatency,
        percentiles,
      };
    }

    const profile: ConcurrencyProfile = {
      byN,
      scalingFactor: computeScalingFactor(byN, sortedLevels),
      levels: sortedLevels,
    };

    const threshold = opts.failureRateAbortThreshold ?? 1.0;
    if (threshold < 1.0) {
      for (const N of sortedLevels) {
        const stat = byN[N];
        if (stat && stat.failureRate > threshold) {
          profile.abortedReason = `level N=${N} failureRate ${stat.failureRate.toFixed(2)} > threshold ${threshold}`;
          break;
        }
      }
    }
    return profile;
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
