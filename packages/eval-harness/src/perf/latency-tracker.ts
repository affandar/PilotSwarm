/**
 * Tiny in-memory latency / cost percentile tracker used by the
 * PERFORMANCE & COST live suite. Pure function (no I/O), no external deps;
 * safe to use in default-skipped tests and as an inspector helper.
 */

export interface LatencyPercentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  meanMs: number;
}

export interface CostBreakdown {
  totalUsd: number;
  perTrialUsd: number;
  trials: number;
}

export class LatencyTracker {
  private samples: number[] = [];

  record(latencyMs: number): void {
    if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error(
        `LatencyTracker: latencyMs must be a finite non-negative number (got ${String(latencyMs)})`,
      );
    }
    this.samples.push(latencyMs);
  }

  reset(): void {
    this.samples = [];
  }

  size(): number {
    return this.samples.length;
  }

  percentiles(): LatencyPercentiles {
    const n = this.samples.length;
    if (n === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, meanMs: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pick = (p: number): number => {
      const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
      return sorted[idx]!;
    };
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
      count: n,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      min: sorted[0]!,
      max: sorted[n - 1]!,
      meanMs: sum / n,
    };
  }
}

export class CostTracker {
  private trialCosts: number[] = [];

  record(usd: number): void {
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
      throw new Error(
        `CostTracker: usd must be a finite non-negative number (got ${String(usd)})`,
      );
    }
    this.trialCosts.push(usd);
  }

  reset(): void {
    this.trialCosts = [];
  }

  breakdown(): CostBreakdown {
    const n = this.trialCosts.length;
    const total = this.trialCosts.reduce((acc, v) => acc + v, 0);
    return {
      totalUsd: total,
      perTrialUsd: n > 0 ? total / n : 0,
      trials: n,
    };
  }
}
